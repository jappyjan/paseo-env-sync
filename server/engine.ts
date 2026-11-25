import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type Activity,
  type Environment,
  type EnvStatus,
  type Installed,
  type Overview,
  type PlannedAction,
  type Profile,
  type SyncConfig,
  ConfigSchema,
  defaultSettings,
  desiredFor,
  GLOBAL,
  planFor,
  profileChain,
  SELF_ID,
} from "../shared/model";
import { isLocal, listPlugins, paseo, paseoOnMachine, readConfig } from "./cli";

interface Runtime {
  snapshots: Record<string, Record<string, Installed>>;
  configSnapshots: Record<string, Record<string, unknown>>;
  managed: Record<string, string[]>;
  lastSync: Record<string, string>;
  lastError: Record<string, string | null>;
  reachable: Record<string, boolean>;
  lastSeen: Record<string, string>;
  offlineSince: Record<string, string | null>;
  failures: Record<string, number>;
  nextAttempt: Record<string, number>;
}
interface StateFile {
  version: 1;
  config: SyncConfig;
  runtime: Runtime;
  activity: Activity[];
}

const HOME = process.env.PASEO_HOME || join(homedir(), ".paseo");
export const STATE_PATH = process.env.PASEO_ENV_SYNC_STATE || join(HOME, "plugin-data", SELF_ID, "state.json");
/** Longest wait between attempts to reach an offline environment. */
const MAX_BACKOFF_MS = 15 * 60_000;

const emptyRuntime = (): Runtime => ({
  snapshots: {}, configSnapshots: {}, managed: {}, lastSync: {}, lastError: {}, reachable: {},
  lastSeen: {}, offlineSince: {}, failures: {}, nextAttempt: {},
});
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
const firstLine = (e: unknown) => (e as Error).message.split("\n")[0];

function ago(iso: string) {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 60) return `${mins} min`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)} h`;
  return `${Math.round(mins / 1440)} days`;
}

export class Engine {
  private state!: StateFile;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  syncing = false;

  async start() {
    await this.load();
    this.schedule(3_000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.exclusive(() => this.tick(false)).finally(() => this.schedule(this.state.config.settings.pollSeconds * 1000));
    }, ms);
  }

  /** Serializes everything that reads or writes environments. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---------- persistence ----------

  private async load() {
    if (existsSync(STATE_PATH)) {
      const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
      this.state = { version: 1, config: ConfigSchema.parse(raw.config), runtime: { ...emptyRuntime(), ...raw.runtime }, activity: raw.activity ?? [] };
      return;
    }
    // First run: seed the global profile from this machine's plugins.
    let installed: Record<string, Installed> = {};
    try { installed = await listPlugins("local"); } catch (e) { console.error("seed failed", e); }
    const plugins: Profile["plugins"] = {};
    for (const [id, p] of Object.entries(installed)) {
      if (id !== SELF_ID) plugins[id] = { source: p.source, state: p.enabled ? "enabled" : "disabled" };
    }
    this.state = {
      version: 1,
      config: {
        profiles: [{ id: GLOBAL, name: "Global", plugins, config: {} }],
        environments: [{ id: "local", name: "This machine", host: "local", profiles: [], syncConfig: false, prune: false, paused: false }],
        settings: defaultSettings,
      },
      runtime: { ...emptyRuntime(), snapshots: { local: installed } },
      activity: [],
    };
    this.log(null, `Created the global profile from this machine's ${Object.keys(plugins).length} plugins`, "info");
    this.save();
  }

  private save() {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const tmp = STATE_PATH + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.state, null, 2));
    renameSync(tmp, STATE_PATH);
  }

  private log(env: string | null, message: string, tone: Activity["tone"]) {
    console.log(`[${env ?? "env-sync"}] ${message}`);
    this.state.activity.unshift({ time: new Date().toISOString(), env, message, tone });
    this.state.activity.length = Math.min(this.state.activity.length, 200);
  }

  // ---------- public API ----------

  overview(): Overview {
    const { config, runtime } = this.state;
    const status: Record<string, EnvStatus> = {};
    for (const env of config.environments) {
      const installed = runtime.snapshots[env.id] ?? null;
      const next = runtime.nextAttempt[env.id];
      status[env.id] = {
        reachable: runtime.reachable[env.id] ?? null,
        lastSync: runtime.lastSync[env.id] ?? null,
        lastError: runtime.lastError[env.id] ?? null,
        installed,
        // For an offline environment this is computed from its last known state: what waits for it.
        pending: installed
          ? planFor(config, env, installed, runtime.managed[env.id] ?? [], runtime.configSnapshots[env.id] ?? null).map((a) => a.label)
          : [],
        lastSeen: runtime.lastSeen[env.id] ?? null,
        offlineSince: runtime.offlineSince[env.id] ?? null,
        nextAttempt: next && next > Date.now() ? new Date(next).toISOString() : null,
      };
    }
    return { config: clone(config), status, activity: this.state.activity.slice(0, 100), syncing: this.syncing, statePath: STATE_PATH };
  }

  saveConfig(config: SyncConfig, apply: boolean) {
    return this.exclusive(async () => {
      if (!config.profiles.some((p) => p.id === GLOBAL)) throw new Error("The global profile cannot be deleted");
      const ids = new Set(config.profiles.map((p) => p.id));
      for (const env of config.environments) env.profiles = env.profiles.filter((p) => ids.has(p) && p !== GLOBAL);
      const known = new Set(config.environments.map((e) => e.id));
      for (const table of Object.values(this.state.runtime)) {
        for (const id of Object.keys(table)) if (!known.has(id)) delete (table as Record<string, unknown>)[id];
      }
      this.state.config = ConfigSchema.parse(config);
      this.log(null, "Profiles and environments saved", "info");
      this.save();
      if (apply && config.settings.autoApply) await this.applyAll(false, undefined, true);
      return this.overview();
    });
  }

  /** Manual sync: ignores the offline backoff and tries every environment now. */
  syncNow(envId: string | undefined, dryRun: boolean) {
    return this.exclusive(async () => {
      if (dryRun) return this.applyAll(true, envId, true);
      await this.tick(true, envId);
      return this.applyAll(false, envId, true);
    });
  }

  importFrom(envId: string, profileId: string) {
    return this.exclusive(async () => {
      const env = this.env(envId);
      const profile = this.state.config.profiles.find((p) => p.id === profileId);
      if (!profile) throw new Error(`No profile ${profileId}`);
      const installed = await listPlugins(env.host);
      this.markOnline(env);
      for (const [id, p] of Object.entries(installed)) {
        if (id !== SELF_ID) profile.plugins[id] = { source: p.source, state: p.enabled ? "enabled" : "disabled" };
      }
      this.state.runtime.snapshots[env.id] = installed;
      this.log(env.name, `Imported ${Object.keys(installed).length} plugins into ${profile.name}`, "good");
      this.save();
      return this.overview();
    });
  }

  async testHost(host: string) {
    try {
      const installed = await listPlugins(host);
      const cfg = paseoOnMachine(host, ["daemon", "config", "get"]) ? "settings sync available" : "plugins only (settings need local or ssh://)";
      return { ok: true, message: `Reachable, ${Object.keys(installed).length} plugins, ${cfg}`, plugins: Object.keys(installed).length };
    } catch (e) {
      return { ok: false, message: firstLine(e), plugins: 0 };
    }
  }

  // ---------- reachability ----------

  private env(id: string): Environment {
    const env = this.state.config.environments.find((e) => e.id === id);
    if (!env) throw new Error(`No environment ${id}`);
    return env;
  }

  private markOnline(env: Environment) {
    const r = this.state.runtime;
    if (r.offlineSince[env.id]) this.log(env.name, `Back online after ${ago(r.offlineSince[env.id]!)}`, "good");
    r.reachable[env.id] = true;
    r.lastSeen[env.id] = new Date().toISOString();
    r.offlineSince[env.id] = null;
    r.failures[env.id] = 0;
    r.nextAttempt[env.id] = 0;
    if (r.lastError[env.id]?.startsWith("offline")) r.lastError[env.id] = null;
  }

  private markOffline(env: Environment, error: unknown) {
    const r = this.state.runtime;
    const failures = (r.failures[env.id] ?? 0) + 1;
    r.failures[env.id] = failures;
    const base = this.state.config.settings.pollSeconds * 1000;
    r.nextAttempt[env.id] = Date.now() + Math.min(base * 2 ** (failures - 1), MAX_BACKOFF_MS);
    if (r.reachable[env.id] !== false) {
      r.offlineSince[env.id] = new Date().toISOString();
      this.log(env.name, `Offline (${firstLine(error)}). Changes for it wait until it is back.`, "warn");
    }
    r.reachable[env.id] = false;
    r.lastError[env.id] = `offline: ${firstLine(error)}`;
  }

  private due(env: Environment, force: boolean) {
    return !env.paused && (force || (this.state.runtime.nextAttempt[env.id] ?? 0) <= Date.now());
  }

  /** Lists plugins on every due environment in parallel. Offline ones back off without blocking others. */
  private async probe(envs: Environment[]): Promise<Map<string, Record<string, Installed>>> {
    const results = await Promise.allSettled(envs.map((env) => listPlugins(env.host)));
    const online = new Map<string, Record<string, Installed>>();
    envs.forEach((env, i) => {
      const r = results[i];
      if (r.status === "fulfilled") {
        this.markOnline(env);
        online.set(env.id, r.value);
      } else {
        this.markOffline(env, r.reason);
      }
    });
    return online;
  }

  // ---------- loop ----------

  private async tick(force: boolean, onlyEnv?: string) {
    const { config, runtime } = this.state;
    try {
      const envs = config.environments.filter((e) => (onlyEnv ? e.id === onlyEnv : true) && this.due(e, force || !!onlyEnv));
      const online = await this.probe(envs);

      // Record what users changed on each environment since we last saw it, including while it was offline.
      let changed = false;
      for (const env of envs) {
        const installed = online.get(env.id);
        if (!installed) continue;
        const prev = runtime.snapshots[env.id];
        if (prev && config.settings.autoCapture) changed = this.capturePlugins(env, prev, installed) || changed;
        runtime.snapshots[env.id] = installed;
        if (env.syncConfig) {
          try {
            const cfg = await readConfig(env.host);
            if (cfg) {
              const prevCfg = runtime.configSnapshots[env.id];
              if (prevCfg && config.settings.autoCapture) changed = this.captureConfig(env, prevCfg, cfg) || changed;
              runtime.configSnapshots[env.id] = cfg;
            }
          } catch (e) {
            runtime.lastError[env.id] = `settings: ${firstLine(e)}`;
          }
        }
      }
      if (changed) this.save();

      if (!force && config.settings.autoApply) {
        await this.applyEnvs(config.environments.filter((e) => online.has(e.id)), false, online);
      }
      this.save();
    } catch (e) {
      console.error("tick failed", e);
    }
  }

  private async applyAll(dryRun: boolean, onlyEnv: string | undefined, force: boolean) {
    const envs = this.state.config.environments.filter((e) => (onlyEnv ? e.id === onlyEnv : this.due(e, force)));
    if (dryRun) {
      // Preview uses each environment's last known plugins, so offline ones show what is waiting.
      return {
        results: envs.map((env) => {
          const installed = this.state.runtime.snapshots[env.id];
          const offline = this.state.runtime.reachable[env.id] === false;
          return {
            env: env.name + (offline ? " (offline, last known state)" : ""),
            actions: installed ? planFor(this.state.config, env, installed, this.state.runtime.managed[env.id] ?? [], this.state.runtime.configSnapshots[env.id] ?? null).map((a) => a.label) : [],
            errors: installed ? [] : ["never reached"],
          };
        }),
      };
    }
    const online = await this.probe(envs);
    return this.applyEnvs(envs, false, online);
  }

  private async applyEnvs(envs: Environment[], dryRun: boolean, online: Map<string, Record<string, Installed>>) {
    this.syncing = true;
    try {
      const results = await Promise.all(
        envs.map((env) => {
          const installed = online.get(env.id);
          if (!installed) {
            const since = this.state.runtime.offlineSince[env.id];
            return Promise.resolve({ env: env.name, actions: [], errors: [`offline${since ? ` for ${ago(since)}` : ""}, will sync when it is back`] });
          }
          return this.reconcile(env, installed, dryRun);
        }),
      );
      return { results };
    } finally {
      this.syncing = false;
      if (!dryRun) this.save();
    }
  }

  private captureProfile(env: Environment): Profile {
    const chain = profileChain(this.state.config, env);
    const wanted = env.captureProfile && chain.find((p) => p.id === env.captureProfile);
    return wanted || chain[chain.length - 1];
  }

  private capturePlugins(env: Environment, prev: Record<string, Installed>, now: Record<string, Installed>): boolean {
    const config = this.state.config;
    const chain = profileChain(config, env);
    const want = desiredFor(config, env);
    const removeScope = config.settings.removeScope;
    let changed = false;

    for (const [id, p] of Object.entries(now)) {
      if (id === SELF_ID) continue;
      const w = want.plugins[id];
      const was = prev[id];
      const state = p.enabled ? "enabled" : "disabled";
      if (!was) {
        if (w && w.state !== "absent" && w.source === p.source) continue; // expected
        const target = this.captureProfile(env);
        target.plugins[id] = { source: p.source, state };
        for (const later of chain.slice(chain.indexOf(target) + 1)) {
          if (later.plugins[id]?.state === "absent") delete later.plugins[id];
        }
        this.log(env.name, `${id} was installed here, added to profile ${target.name}`, "good");
        changed = true;
      } else if (w && w.state !== "absent") {
        const owner = config.profiles.find((x) => x.id === w.from)!;
        if (was.enabled !== p.enabled && w.state !== state) {
          owner.plugins[id] = { ...owner.plugins[id], state };
          this.log(env.name, `${id} was ${state} here, updated in profile ${owner.name}`, "good");
          changed = true;
        }
        if (was.source !== p.source && w.source !== p.source) {
          owner.plugins[id] = { ...owner.plugins[id], source: p.source };
          this.log(env.name, `${id} now installs from ${p.source} (profile ${owner.name})`, "info");
          changed = true;
        }
      }
    }

    for (const id of Object.keys(prev)) {
      if (id === SELF_ID || now[id]) continue;
      const w = want.plugins[id];
      if (!w || w.state === "absent") continue;
      if (removeScope === "profile") {
        const owners = chain.filter((p) => p.plugins[id] && p.plugins[id].state !== "absent");
        for (const p of owners) delete p.plugins[id];
        this.log(env.name, `${id} was removed here, removed from profile ${owners.map((p) => p.name).join(", ")}`, "warn");
      } else {
        const target = this.captureProfile(env);
        target.plugins[id] = { source: w.source, state: "absent" };
        this.log(env.name, `${id} was removed here, excluded in profile ${target.name}`, "warn");
      }
      changed = true;
    }
    return changed;
  }

  private captureConfig(env: Environment, prev: Record<string, unknown>, now: Record<string, unknown>): boolean {
    const chain = profileChain(this.state.config, env);
    let changed = false;
    for (const profile of [...chain].reverse()) {
      for (const path of Object.keys(profile.config)) {
        const owner = [...chain].reverse().find((p) => path in p.config);
        const before = JSON.stringify(prev[path]);
        const after = JSON.stringify(now[path]);
        if (owner !== profile || before === after || after === JSON.stringify(profile.config[path]) || now[path] === undefined) continue;
        profile.config[path] = now[path] as never;
        this.log(env.name, `${path} changed here, updated in profile ${profile.name}`, "good");
        changed = true;
      }
    }
    return changed;
  }

  private async reconcile(env: Environment, installed: Record<string, Installed>, dryRun: boolean) {
    const { runtime, config } = this.state;
    const result = { env: env.name, actions: [] as string[], errors: [] as string[] };
    const managed = new Set(runtime.managed[env.id] ?? []);
    const plan: PlannedAction[] = planFor(config, env, installed, [...managed], env.syncConfig ? runtime.configSnapshots[env.id] ?? null : null);
    if (dryRun) {
      result.actions = plan.map((a) => a.label);
      return result;
    }
    let configTouched = false;
    for (const a of plan) {
      try {
        switch (a.kind) {
          case "install":
            await paseo(env.host, ["plugin", "add", a.source!, "--id", a.pluginId!, ...(a.ref ? ["--ref", a.ref] : [])], 600_000);
            managed.add(a.pluginId!);
            break;
          case "enable":
          case "disable":
            await paseo(env.host, ["plugin", a.kind, a.pluginId!], 60_000);
            break;
          case "remove":
            await paseo(env.host, ["plugin", "remove", a.pluginId!], 60_000);
            managed.delete(a.pluginId!);
            break;
          case "config": {
            const run = paseoOnMachine(env.host, ["daemon", "config", "set", a.path!, JSON.stringify(a.value)]);
            if (!run) throw new Error("settings can only be written on local or ssh:// environments");
            await run;
            configTouched = true;
            break;
          }
        }
        result.actions.push(a.label);
        this.log(env.name, a.label, "good");
      } catch (e) {
        // The device may have dropped off mid-sync: stop here, the rest is retried when it is back.
        const stillThere = await listPlugins(env.host, 10_000).then(() => true, () => false);
        if (!stillThere) {
          this.markOffline(env, e);
          result.errors.push(`went offline during sync; ${plan.length - result.actions.length} changes wait for it`);
          break;
        }
        const msg = `${a.label}: ${firstLine(e)}`;
        result.errors.push(msg);
        if (runtime.lastError[env.id] !== msg) this.log(env.name, msg, "bad");
        runtime.lastError[env.id] = msg;
      }
    }
    if (configTouched) {
      try { await paseo(env.host, ["reload"], 30_000); } catch (e) { result.errors.push(`reload: ${firstLine(e)}`); }
    }
    runtime.managed[env.id] = [...managed];
    if (runtime.reachable[env.id] !== false) {
      // Re-read so our own changes are not mistaken for user changes next time.
      try { runtime.snapshots[env.id] = await listPlugins(env.host); } catch { /* next tick */ }
      if (configTouched) {
        try { const cfg = await readConfig(env.host); if (cfg) runtime.configSnapshots[env.id] = cfg; } catch { /* next tick */ }
      }
      if (!result.errors.length) runtime.lastError[env.id] = null;
    }
    if (plan.length) runtime.lastSync[env.id] = new Date().toISOString();
    return result;
  }
}
