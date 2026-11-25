import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useRpc } from "@getpaseo/plugin/client";
import {
  copyText,
  ScrollView,
  SettingsAction,
  SettingsInput,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
  TextInput,
  useToast,
} from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  type Environment,
  type Overview,
  type PluginState,
  type SyncConfig,
  getOverview,
  GLOBAL,
  importFromEnv,
  saveConfig,
  SELF_ID,
  syncNow,
  testHost,
} from "../shared/model";

type Theme = PluginScreenProps["theme"];
const TABS = ["Profiles", "Environments", "Activity", "Settings"] as const;
type Tab = (typeof TABS)[number];
const CYCLE: (PluginState | null)[] = [null, "enabled", "disabled", "absent"];
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const when = (iso: string) => {
  const d = new Date(iso);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString();
};
const slug = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function useStyles(theme: Theme, compact: boolean) {
  return useMemo(() => {
    const c = theme.colors;
    return {
      c,
      screen: { flex: 1, backgroundColor: c.surface0 },
      body: { padding: compact ? 12 : 24, gap: 16, paddingBottom: 48 },
      row: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8, flexWrap: "wrap" as const },
      text: { color: c.foreground, fontSize: 14 },
      muted: { color: c.foregroundMuted, fontSize: 12 },
      title: { color: c.foreground, fontSize: compact ? 18 : 22, fontWeight: "600" as const },
      card: { borderWidth: 1, borderColor: c.border, borderRadius: 10, padding: 12, gap: 8, backgroundColor: c.surface1 },
      chip: (on: boolean) => ({
        paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1,
        borderColor: on ? c.accent : c.border, backgroundColor: on ? c.accent : "transparent",
      }),
      chipText: (on: boolean) => ({ color: on ? c.accentForeground : c.foreground, fontSize: 12 }),
      button: (primary = false) => ({
        paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8, borderWidth: 1,
        borderColor: primary ? c.accent : c.border, backgroundColor: primary ? c.accent : c.surface2,
      }),
      buttonText: (primary = false) => ({ color: primary ? c.accentForeground : c.foreground, fontSize: 13 }),
      input: { borderWidth: 1, borderColor: c.border, borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6, color: c.foreground, minWidth: 140, flexGrow: 1 },
      cell: { width: compact ? 74 : 96, alignItems: "center" as const, justifyContent: "center" as const, paddingVertical: 6 },
      nameCell: { width: compact ? 130 : 220, paddingVertical: 6 },
      tone: { good: c.statusSuccess, warn: c.statusWarning, bad: c.statusDanger, info: c.foregroundMuted },
    };
  }, [theme, compact]);
}
type Styles = ReturnType<typeof useStyles>;

function Button({ s, label, onPress, primary, disabled }: { s: Styles; label: string; onPress(): void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress} style={[s.button(primary), disabled ? { opacity: 0.5 } : null]}>
      <Text style={s.buttonText(primary)}>{label}</Text>
    </Pressable>
  );
}

function Chip({ s, label, on, onPress }: { s: Styles; label: string; on: boolean; onPress?(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={onPress} disabled={!onPress} style={s.chip(on)}>
      <Text style={s.chipText(on)}>{label}</Text>
    </Pressable>
  );
}

export function EnvSyncScreen({ theme, layout }: PluginScreenProps) {
  const s = useStyles(theme, layout.compact);
  const toast = useToast();
  const qc = useQueryClient();
  const overviewRpc = useRpc(getOverview);
  const saveRpc = useRpc(saveConfig);
  const syncRpc = useRpc(syncNow);
  const testRpc = useRpc(testHost);
  const importRpc = useRpc(importFromEnv);

  const overview = useQuery({ queryKey: ["envsync", "overview"], queryFn: () => overviewRpc({}), refetchInterval: 5000 });
  const [tab, setTab] = useState<Tab>("Profiles");
  const [draft, setDraft] = useState<SyncConfig | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (overview.data && !dirty) setDraft(clone(overview.data.config));
  }, [overview.data, dirty]);

  const edit = (fn: (d: SyncConfig) => void) => {
    setDraft((d) => {
      if (!d) return d;
      const next = clone(d);
      fn(next);
      return next;
    });
    setDirty(true);
  };

  const setData = (data: Overview) => qc.setQueryData(["envsync", "overview"], data);
  const save = useMutation({
    mutationFn: () => saveRpc({ config: draft!, apply: true }),
    onSuccess: (data) => { setDirty(false); setData(data); toast.show("Saved, syncing environments", { variant: "success" }); },
    onError: (e) => toast.show((e as Error).message, { variant: "error" }),
  });
  const sync = useMutation({
    mutationFn: (v: { envId?: string; dryRun: boolean }) => syncRpc(v),
    onSuccess: (r, v) => {
      const lines = r.results.flatMap((x) => [...x.actions.map((a) => `${x.env}: ${a}`), ...x.errors.map((e) => `${x.env}: ✗ ${e}`)]);
      toast.show(lines.length ? (v.dryRun ? "Would: " : "") + lines.slice(0, 6).join("\n") : "Everything is in sync", { variant: r.results.some((x) => x.errors.length) ? "warning" : "success" });
      void overview.refetch();
    },
    onError: (e) => toast.show((e as Error).message, { variant: "error" }),
  });

  if (!overview.data || !draft) {
    return (
      <View style={[s.screen, s.body]}>
        <Text style={s.muted}>{overview.error ? String(overview.error) : "Loading…"}</Text>
      </View>
    );
  }
  const data = overview.data;

  return (
    <View style={s.screen}>
      <ScrollView contentContainerStyle={s.body}>
        <View style={[s.row, { justifyContent: "space-between" }]}>
          <View style={{ gap: 2, flexShrink: 1 }}>
            <Text style={s.title}>Environment sync</Text>
            <Text style={s.muted}>
              {data.syncing ? "Syncing…" : `${draft.environments.length} environments · ${draft.profiles.length} profiles · checks every ${draft.settings.pollSeconds}s`}
            </Text>
          </View>
          <View style={s.row}>
            {dirty && <Button s={s} label="Discard" onPress={() => setDirty(false)} />}
            {dirty && <Button s={s} primary label={save.isPending ? "Saving…" : "Save and sync"} onPress={() => save.mutate()} disabled={save.isPending} />}
            {!dirty && <Button s={s} label="Preview" onPress={() => sync.mutate({ dryRun: true })} disabled={sync.isPending} />}
            {!dirty && <Button s={s} primary label={sync.isPending ? "Syncing…" : "Sync now"} onPress={() => sync.mutate({ dryRun: false })} disabled={sync.isPending} />}
          </View>
        </View>

        <View style={s.row}>
          {TABS.map((t) => <Chip key={t} s={s} label={t} on={tab === t} onPress={() => setTab(t)} />)}
        </View>

        {tab === "Profiles" && <ProfilesTab s={s} draft={draft} data={data} edit={edit} />}
        {tab === "Environments" && (
          <EnvironmentsTab
            s={s} draft={draft} data={data} edit={edit} dirty={dirty}
            onSync={(envId, dryRun) => sync.mutate({ envId, dryRun })}
            onTest={async (host) => {
              const r = await testRpc({ host });
              toast.show(r.message, { variant: r.ok ? "success" : "error" });
            }}
            onImport={async (envId, profileId) => {
              try { setData(await importRpc({ envId, profileId })); setDirty(false); toast.show("Imported", { variant: "success" }); }
              catch (e) { toast.show((e as Error).message, { variant: "error" }); }
            }}
          />
        )}
        {tab === "Activity" && <ActivityTab s={s} data={data} />}
        {tab === "Settings" && <SettingsTab s={s} draft={draft} data={data} edit={edit} />}
      </ScrollView>
    </View>
  );
}

// ---------- Profiles ----------

function ProfilesTab({ s, draft, data, edit }: { s: Styles; draft: SyncConfig; data: Overview; edit(fn: (d: SyncConfig) => void): void }) {
  const [newProfile, setNewProfile] = useState("");
  const [newPlugin, setNewPlugin] = useState("");

  // Every plugin any profile or environment knows about, with a source to install it from.
  const sources = new Map<string, string>();
  for (const st of Object.values(data.status)) for (const [id, p] of Object.entries(st.installed ?? {})) if (id !== SELF_ID) sources.set(id, p.source);
  for (const p of draft.profiles) for (const [id, e] of Object.entries(p.plugins)) sources.set(id, e.source);
  const ids = [...sources.keys()].sort();

  const cycle = (profileId: string, id: string) =>
    edit((d) => {
      const p = d.profiles.find((x) => x.id === profileId)!;
      const cur = p.plugins[id]?.state ?? null;
      const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length];
      if (next === null || (next === "absent" && profileId === GLOBAL)) delete p.plugins[id];
      else p.plugins[id] = { source: p.plugins[id]?.source ?? sources.get(id)!, state: next };
    });

  const glyph = (st: PluginState | undefined) => (st === "enabled" ? "●" : st === "disabled" ? "○" : st === "absent" ? "✕" : "·");
  const color = (st: PluginState | undefined) =>
    st === "enabled" ? s.c.statusSuccess : st === "disabled" ? s.c.statusWarning : st === "absent" ? s.c.statusDanger : s.c.foregroundMuted;

  return (
    <View style={{ gap: 16 }}>
      <Text style={s.muted}>
        Tap a cell to cycle: · not set → ● installed → ○ installed but disabled → ✕ removed (sub-profiles only). An environment gets Global plus its own profiles, later ones win.
      </Text>
      <ScrollView horizontal>
        <View style={s.card}>
          <View style={{ flexDirection: "row" }}>
            <View style={s.nameCell}><Text style={s.muted}>Plugin</Text></View>
            {draft.profiles.map((p) => (
              <View key={p.id} style={s.cell}><Text style={[s.text, { fontWeight: "600" }]} numberOfLines={1}>{p.name}</Text></View>
            ))}
          </View>
          {ids.map((id) => (
            <View key={id} style={{ flexDirection: "row", borderTopWidth: 1, borderTopColor: s.c.border }}>
              <View style={s.nameCell}>
                <Text style={s.text} numberOfLines={1}>{id}</Text>
                <Text style={s.muted} numberOfLines={1}>{sources.get(id)}</Text>
              </View>
              {draft.profiles.map((p) => {
                const st = p.plugins[id]?.state;
                return (
                  <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={`${id} in ${p.name}: ${st ?? "not set"}`} onPress={() => cycle(p.id, id)} style={s.cell}>
                    <Text style={{ color: color(st), fontSize: 18 }}>{glyph(st)}</Text>
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>

      <View style={s.row}>
        <TextInput style={s.input} placeholder="Add a plugin: owner/slug, git:…, npm:…" placeholderTextColor={s.c.foregroundMuted} value={newPlugin} onChangeText={setNewPlugin} />
        <Button s={s} label="Add to Global" disabled={!newPlugin.trim()} onPress={() => {
          const source = newPlugin.trim();
          const id = source.split(/[/:]/).pop()!.replace(/\.git$/, "");
          edit((d) => { d.profiles.find((p) => p.id === GLOBAL)!.plugins[id] = { source, state: "enabled" }; });
          setNewPlugin("");
        }} />
      </View>

      <SettingsSection title="Profiles">
        {draft.profiles.map((p) => (
          <View key={p.id} style={[s.card, { marginBottom: 8 }]}>
            <View style={[s.row, { justifyContent: "space-between" }]}>
              <Text style={[s.text, { fontWeight: "600" }]}>{p.name}{p.id === GLOBAL ? " (all environments)" : ""}</Text>
              {p.id !== GLOBAL && <Button s={s} label="Delete" onPress={() => edit((d) => { d.profiles = d.profiles.filter((x) => x.id !== p.id); })} />}
            </View>
            <Text style={s.muted}>
              Used by: {p.id === GLOBAL ? "every environment" : draft.environments.filter((e) => e.profiles.includes(p.id)).map((e) => e.name).join(", ") || "no environment yet"}
            </Text>
            <ConfigEditor s={s} profileId={p.id} config={p.config} edit={edit} />
          </View>
        ))}
        <View style={s.row}>
          <TextInput style={s.input} placeholder="New profile, e.g. Work" placeholderTextColor={s.c.foregroundMuted} value={newProfile} onChangeText={setNewProfile} />
          <Button s={s} label="Add profile" disabled={!slug(newProfile) || draft.profiles.some((p) => p.id === slug(newProfile))} onPress={() => {
            edit((d) => { d.profiles.push({ id: slug(newProfile), name: newProfile.trim(), plugins: {}, config: {} }); });
            setNewProfile("");
          }} />
        </View>
      </SettingsSection>
    </View>
  );
}

function ConfigEditor({ s, profileId, config, edit }: { s: Styles; profileId: string; config: Record<string, unknown>; edit(fn: (d: SyncConfig) => void): void }) {
  const [path, setPath] = useState("");
  const [value, setValue] = useState("");
  let parsed: unknown;
  let valid = false;
  try { parsed = JSON.parse(value); valid = !!path.trim(); } catch { valid = false; }
  return (
    <View style={{ gap: 6 }}>
      <Text style={s.muted}>Settings (config.json paths, applied on local and ssh:// environments with settings sync on)</Text>
      {Object.entries(config).map(([k, v]) => (
        <View key={k} style={[s.row, { justifyContent: "space-between" }]}>
          <Text style={s.text}>{k} = {JSON.stringify(v)}</Text>
          <Button s={s} label="Remove" onPress={() => edit((d) => { delete d.profiles.find((p) => p.id === profileId)!.config[k]; })} />
        </View>
      ))}
      <View style={s.row}>
        <TextInput style={s.input} placeholder="features.voiceMode.enabled" placeholderTextColor={s.c.foregroundMuted} value={path} onChangeText={setPath} autoCapitalize="none" />
        <TextInput style={s.input} placeholder="JSON value, e.g. true" placeholderTextColor={s.c.foregroundMuted} value={value} onChangeText={setValue} autoCapitalize="none" />
        <Button s={s} label="Add setting" disabled={!valid} onPress={() => {
          edit((d) => { d.profiles.find((p) => p.id === profileId)!.config[path.trim()] = parsed as never; });
          setPath(""); setValue("");
        }} />
      </View>
    </View>
  );
}

// ---------- Environments ----------

function EnvironmentsTab(props: {
  s: Styles; draft: SyncConfig; data: Overview; dirty: boolean;
  edit(fn: (d: SyncConfig) => void): void;
  onSync(envId: string, dryRun: boolean): void;
  onTest(host: string): Promise<void>;
  onImport(envId: string, profileId: string): Promise<void>;
}) {
  const { s, draft, data, edit, dirty } = props;
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const subProfiles = draft.profiles.filter((p) => p.id !== GLOBAL);
  const patch = (id: string, fn: (e: Environment) => void) => edit((d) => fn(d.environments.find((e) => e.id === id)!));

  return (
    <View style={{ gap: 12 }}>
      {draft.environments.map((env) => {
        const st = data.status[env.id];
        const toneColor = st?.reachable === false ? s.c.statusDanger : st?.pending.length ? s.c.statusWarning : s.c.statusSuccess;
        const waiting = st?.pending.length ? `, ${st.pending.length} change${st.pending.length > 1 ? "s" : ""} waiting` : "";
        const label = env.paused
          ? "paused"
          : st?.reachable === false
            ? `offline${st.offlineSince ? ` since ${when(st.offlineSince)}` : ""}${waiting}`
            : st?.pending.length ? `${st.pending.length} pending` : st?.reachable ? "in sync" : "not checked yet";
        return (
          <View key={env.id} style={s.card}>
            <View style={[s.row, { justifyContent: "space-between" }]}>
              <View style={{ gap: 2, flexShrink: 1 }}>
                <Text style={[s.text, { fontWeight: "600" }]}>{env.name}</Text>
                <Text style={s.muted}>{env.host}{st?.installed ? ` · ${Object.keys(st.installed).length} plugins` : ""}{st?.lastSync ? ` · synced ${new Date(st.lastSync).toLocaleTimeString()}` : ""}</Text>
              </View>
              <Text style={{ color: toneColor, fontSize: 12 }}>● {label}</Text>
            </View>
            <View style={s.row}>
              <Chip s={s} label="Global" on />
              {subProfiles.map((p) => (
                <Chip key={p.id} s={s} label={p.name} on={env.profiles.includes(p.id)} onPress={() => patch(env.id, (e) => {
                  e.profiles = e.profiles.includes(p.id) ? e.profiles.filter((x) => x !== p.id) : [...e.profiles, p.id];
                  if (e.captureProfile && !e.profiles.includes(e.captureProfile) && e.captureProfile !== GLOBAL) e.captureProfile = undefined;
                })} />
              ))}
            </View>
            <SettingsSelect
              label="New plugins installed here go to"
              value={env.captureProfile ?? "__last"}
              options={[
                { label: `Most specific profile (${draft.profiles.find((p) => p.id === env.profiles[env.profiles.length - 1])?.name ?? "Global"})`, value: "__last" },
                { label: "Global", value: GLOBAL },
                ...env.profiles.map((id) => ({ label: draft.profiles.find((p) => p.id === id)?.name ?? id, value: id })),
              ]}
              onValueChange={(v) => patch(env.id, (e) => { e.captureProfile = v === "__last" ? undefined : v; })}
            />
            <SettingsSwitch label="Sync settings" hint="Writes profile settings to config.json. Needs local or ssh:// host." value={env.syncConfig} onValueChange={(v) => patch(env.id, (e) => { e.syncConfig = v; })} />
            <SettingsSwitch label="Remove plugins no profile has" hint="Off: only removes plugins env-sync installed." value={env.prune} onValueChange={(v) => patch(env.id, (e) => { e.prune = v; })} />
            <SettingsSwitch label="Paused" value={env.paused} onValueChange={(v) => patch(env.id, (e) => { e.paused = v; })} />
            {!!st?.pending.length && (
              <View style={{ gap: 2 }}>
                {st.pending.slice(0, 8).map((p) => <Text key={p} style={s.muted}>→ {p}</Text>)}
              </View>
            )}
            {st?.reachable === false && (
              <Text style={s.muted}>
                {st.lastSeen ? `Last seen ${when(st.lastSeen)}. ` : "Never reached. "}
                {st.nextAttempt ? `Next try ${when(st.nextAttempt)}. ` : ""}Changes made on it while offline are recorded when it comes back; profile changes are applied then.
              </Text>
            )}
            {!!st?.lastError && st.reachable !== false && <Text style={{ color: s.c.statusDanger, fontSize: 12 }}>{st.lastError}</Text>}
            <View style={s.row}>
              <Button s={s} label="Test" onPress={() => void props.onTest(env.host)} />
              <Button s={s} label="Preview" disabled={dirty} onPress={() => props.onSync(env.id, true)} />
              <Button s={s} label={st?.reachable === false ? "Retry now" : "Sync"} disabled={dirty} onPress={() => props.onSync(env.id, false)} />
              {draft.profiles.map((p) => (
                <Button key={p.id} s={s} label={`Import into ${p.name}`} disabled={dirty} onPress={() => void props.onImport(env.id, p.id)} />
              ))}
              {env.id !== "local" && <Button s={s} label="Remove" onPress={() => edit((d) => { d.environments = d.environments.filter((e) => e.id !== env.id); })} />}
            </View>
          </View>
        );
      })}

      <SettingsSection title="Add an environment">
        <View style={[s.card, { gap: 8 }]}>
          <Text style={s.muted}>Host: ssh://user@machine (plugins and settings), host:port or a pairing URL (plugins only). The remote daemon must be running.</Text>
          <View style={s.row}>
            <TextInput style={s.input} placeholder="Name, e.g. Work MacBook" placeholderTextColor={s.c.foregroundMuted} value={name} onChangeText={setName} />
            <TextInput style={s.input} placeholder="ssh://jappy@macbook-pro-von-jan" placeholderTextColor={s.c.foregroundMuted} value={host} onChangeText={setHost} autoCapitalize="none" />
          </View>
          <View style={s.row}>
            <Button s={s} label="Test connection" disabled={!host.trim()} onPress={() => void props.onTest(host.trim())} />
            <Button s={s} primary label="Add" disabled={!name.trim() || !host.trim()} onPress={() => {
              const id = slug(name) || `env-${Date.now()}`;
              edit((d) => {
                d.environments.push({ id: d.environments.some((e) => e.id === id) ? `${id}-${Date.now()}` : id, name: name.trim(), host: host.trim(), profiles: [], syncConfig: host.trim().startsWith("ssh://"), prune: false, paused: false });
              });
              setName(""); setHost("");
            }} />
          </View>
        </View>
      </SettingsSection>
    </View>
  );
}

// ---------- Activity & settings ----------

function ActivityTab({ s, data }: { s: Styles; data: Overview }) {
  if (!data.activity.length) return <Text style={s.muted}>Nothing yet.</Text>;
  return (
    <View style={s.card}>
      {data.activity.map((a, i) => (
        <View key={i} style={{ flexDirection: "row", gap: 8, paddingVertical: 3 }}>
          <Text style={[s.muted, { width: 70 }]}>{new Date(a.time).toLocaleTimeString()}</Text>
          <Text style={{ color: s.tone[a.tone], fontSize: 13, flexShrink: 1 }}>{a.env ? `${a.env}: ` : ""}{a.message}</Text>
        </View>
      ))}
    </View>
  );
}

function SettingsTab({ s, draft, data, edit }: { s: Styles; draft: SyncConfig; data: Overview; edit(fn: (d: SyncConfig) => void): void }) {
  return (
    <View style={{ gap: 12 }}>
      <SettingsSection title="Behaviour">
        <SettingsSwitch label="Record changes" hint="A plugin installed, removed, enabled or disabled on any environment is recorded in its profile." value={draft.settings.autoCapture} onValueChange={(v) => edit((d) => { d.settings.autoCapture = v; })} />
        <SettingsSwitch label="Apply automatically" hint="Push profile changes to every environment on each check. Off: use Sync now." value={draft.settings.autoApply} onValueChange={(v) => edit((d) => { d.settings.autoApply = v; })} />
        <SettingsSelect
          label="Removing a plugin on one environment"
          value={draft.settings.removeScope}
          options={[
            { label: "Removes it from its profile (every environment using that profile)", value: "profile" },
            { label: "Excludes it only in that environment's profile", value: "environment" },
          ]}
          onValueChange={(v) => edit((d) => { d.settings.removeScope = v as "profile" | "environment"; })}
        />
        <SettingsInput label="Check every (seconds)" initialValue={String(draft.settings.pollSeconds)} onChangeText={(t) => {
          const n = Number(t);
          if (Number.isInteger(n) && n >= 10 && n <= 3600) edit((d) => { d.settings.pollSeconds = n; });
        }} />
        <SettingsAction label="State file" hint={data.statePath} actionLabel="Copy path" onPress={() => void copyText(data.statePath)} />
      </SettingsSection>
    </View>
  );
}
