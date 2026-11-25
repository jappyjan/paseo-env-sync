import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const SELF_ID = "paseo-env-sync";
export const GLOBAL = "global";

// ---------- Model ----------

/** What a profile says about one plugin. "absent" removes it even if an earlier profile adds it. */
export const PluginStateSchema = z.enum(["enabled", "disabled", "absent"]);
export type PluginState = z.infer<typeof PluginStateSchema>;

export const PluginEntrySchema = z.object({
  source: z.string(),
  ref: z.string().optional(),
  state: PluginStateSchema,
});
export type PluginEntry = z.infer<typeof PluginEntrySchema>;

export const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string(),
  plugins: z.record(z.string(), PluginEntrySchema),
  /** Dotted config.json paths and their values, e.g. "features.voiceMode.enabled": true */
  config: z.record(z.string(), z.json()),
});
export type Profile = z.infer<typeof ProfileSchema>;

export const EnvironmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** "local", "ssh://user@host", "host:port" or anything `paseo --host` accepts */
  host: z.string(),
  /** Extra profiles on top of global, in order; later ones win. */
  profiles: z.array(z.string()),
  /** Profile that new plugins installed on this environment are added to. Defaults to the last profile. */
  captureProfile: z.string().optional(),
  /** Write config values (needs local or ssh:// host). */
  syncConfig: z.boolean(),
  /** Remove plugins that no profile mentions. Off: only plugins env-sync installed get removed. */
  prune: z.boolean(),
  paused: z.boolean(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;

export const SettingsSchema = z.object({
  pollSeconds: z.number().int().min(10).max(3600),
  /** Record plugin changes made on any environment into the profiles. */
  autoCapture: z.boolean(),
  /** Push profile changes to every environment right away. */
  autoApply: z.boolean(),
  /** Removing a plugin on an environment: remove it from the profile that provides it, or only exclude it there. */
  removeScope: z.enum(["profile", "environment"]),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const ConfigSchema = z.object({
  profiles: z.array(ProfileSchema),
  environments: z.array(EnvironmentSchema),
  settings: SettingsSchema,
});
export type SyncConfig = z.infer<typeof ConfigSchema>;

export const InstalledSchema = z.object({ source: z.string(), enabled: z.boolean() });
export type Installed = z.infer<typeof InstalledSchema>;

export const EnvStatusSchema = z.object({
  reachable: z.boolean().nullable(),
  lastSync: z.string().nullable(),
  lastError: z.string().nullable(),
  installed: z.record(z.string(), InstalledSchema).nullable(),
  pending: z.array(z.string()),
  /** Last time the environment answered. */
  lastSeen: z.string().nullable(),
  /** Set while the environment is offline. */
  offlineSince: z.string().nullable(),
  /** When the next connection attempt is due (offline environments back off). */
  nextAttempt: z.string().nullable(),
});
export type EnvStatus = z.infer<typeof EnvStatusSchema>;

export const ActivitySchema = z.object({
  time: z.string(),
  env: z.string().nullable(),
  message: z.string(),
  tone: z.enum(["info", "good", "warn", "bad"]),
});
export type Activity = z.infer<typeof ActivitySchema>;

export const defaultSettings: Settings = {
  pollSeconds: 60,
  autoCapture: true,
  autoApply: true,
  removeScope: "profile",
};

// ---------- Resolution ----------

export function profileChain(config: SyncConfig, env: Environment): Profile[] {
  const ids = [GLOBAL, ...env.profiles.filter((p) => p !== GLOBAL)];
  return ids.map((id) => config.profiles.find((p) => p.id === id)).filter((p): p is Profile => !!p);
}

export interface Desired {
  plugins: Record<string, PluginEntry & { from: string }>;
  config: Record<string, unknown>;
}

/** Merges global and the environment's profiles in order; later profiles win. */
export function desiredFor(config: SyncConfig, env: Environment): Desired {
  const out: Desired = { plugins: {}, config: {} };
  for (const profile of profileChain(config, env)) {
    for (const [id, entry] of Object.entries(profile.plugins)) {
      if (id === SELF_ID) continue;
      out.plugins[id] = { ...entry, from: profile.id };
    }
    Object.assign(out.config, profile.config);
  }
  return out;
}

export interface PlannedAction {
  kind: "install" | "enable" | "disable" | "remove" | "config";
  pluginId?: string;
  source?: string;
  ref?: string;
  path?: string;
  value?: unknown;
  label: string;
}

export function planFor(
  config: SyncConfig,
  env: Environment,
  installed: Record<string, Installed>,
  managed: string[],
  currentConfig: Record<string, unknown> | null,
): PlannedAction[] {
  const want = desiredFor(config, env);
  const actions: PlannedAction[] = [];
  for (const [id, entry] of Object.entries(want.plugins)) {
    const have = installed[id];
    if (entry.state === "absent") {
      if (have) actions.push({ kind: "remove", pluginId: id, label: `Remove ${id} (excluded by ${entry.from})` });
      continue;
    }
    if (!have) {
      actions.push({ kind: "install", pluginId: id, source: entry.source, ref: entry.ref, label: `Install ${id} from ${entry.source}` });
      if (entry.state === "disabled") actions.push({ kind: "disable", pluginId: id, label: `Disable ${id}` });
    } else if (have.enabled !== (entry.state === "enabled")) {
      actions.push({ kind: entry.state === "enabled" ? "enable" : "disable", pluginId: id, label: `${entry.state === "enabled" ? "Enable" : "Disable"} ${id}` });
    }
  }
  for (const id of Object.keys(installed)) {
    if (id === SELF_ID || want.plugins[id]) continue;
    if (env.prune || managed.includes(id)) actions.push({ kind: "remove", pluginId: id, label: `Remove ${id} (no profile has it)` });
  }
  if (env.syncConfig && currentConfig) {
    for (const [path, value] of Object.entries(want.config)) {
      if (JSON.stringify(currentConfig[path]) !== JSON.stringify(value)) {
        actions.push({ kind: "config", path, value, label: `Set ${path} = ${JSON.stringify(value)}` });
      }
    }
  }
  return actions;
}

// ---------- RPC ----------

const OverviewSchema = z.object({
  config: ConfigSchema,
  status: z.record(z.string(), EnvStatusSchema),
  activity: z.array(ActivitySchema),
  syncing: z.boolean(),
  statePath: z.string(),
});
export type Overview = z.infer<typeof OverviewSchema>;

export const getOverview = defineRpc({ name: "envsync.overview", input: z.object({}), output: OverviewSchema });

export const saveConfig = defineRpc({
  name: "envsync.save",
  input: z.object({ config: ConfigSchema, apply: z.boolean() }),
  output: OverviewSchema,
});

export const syncNow = defineRpc({
  name: "envsync.sync",
  input: z.object({ envId: z.string().optional(), dryRun: z.boolean() }),
  output: z.object({ results: z.array(z.object({ env: z.string(), actions: z.array(z.string()), errors: z.array(z.string()) })) }),
});

export const testHost = defineRpc({
  name: "envsync.test-host",
  input: z.object({ host: z.string() }),
  output: z.object({ ok: z.boolean(), message: z.string(), plugins: z.number() }),
});

export const importFromEnv = defineRpc({
  name: "envsync.import",
  input: z.object({ envId: z.string(), profileId: z.string() }),
  output: OverviewSchema,
});
