import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import type { Installed } from "../shared/model";

const CANDIDATES = [
  "/Applications/Paseo.app/Contents/Resources/bin/paseo",
  "/usr/local/bin/paseo",
  "/opt/homebrew/bin/paseo",
];

function resolveCli(): string {
  if (process.env.PASEO_ENV_SYNC_CLI) return process.env.PASEO_ENV_SYNC_CLI;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const p = join(dir, "paseo");
    if (dir && existsSync(p)) return p;
  }
  return CANDIDATES.find((p) => existsSync(p)) ?? "paseo";
}

const CLI = resolveCli();
// Keep the node that runs this plugin on PATH so a node-shebang CLI resolves.
const ENV = { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ""].join(delimiter) };

export const isLocal = (host: string) => !host || host === "local";
export const sshTarget = (host: string) => /^ssh:\/\/([^/?]+)/.exec(host)?.[1] ?? null;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The CLI reports errors as JSON on stdout with --json, as text on stderr otherwise. */
function errorText(stdout: string, stderr: string, fallback: string): string {
  for (const out of [stdout, stderr]) {
    try {
      const parsed = JSON.parse(out) as { error?: { message?: string; code?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch { /* not JSON */ }
  }
  const text = (stderr || stdout || fallback).trim().split("\n").filter((l) => !/^\s+at /.test(l));
  return text.slice(0, 3).join("\n") || fallback;
}

function exec(file: string, args: string[], timeoutMs = 180_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { env: ENV, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if (err.killed) return reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`));
      reject(new Error(errorText(stdout, stderr, err.message)));
    });
  });
}

/** Runs `paseo <args> [--host host]` from this machine. */
export function paseo(host: string, args: string[], timeoutMs?: number) {
  return exec(CLI, [...args, ...(isLocal(host) ? [] : ["--host", host])], timeoutMs);
}

/** Runs a local-only paseo command on the environment's machine (local, or over ssh). */
export function paseoOnMachine(host: string, args: string[]): Promise<string> | null {
  if (isLocal(host)) return exec(CLI, args);
  const target = sshTarget(host);
  if (!target) return null;
  const remote = ["paseo", ...args].map(shq).join(" ");
  return exec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, `exec "$SHELL" -lc ${shq(remote)}`]);
}

interface ListedPlugin {
  id: string;
  path?: string;
  enabled?: boolean;
  installation?: {
    identity?: { kind?: string; remote?: string; packageName?: string; registry?: { id?: string } };
    currentRevision?: string;
  };
}

function sourceOf(p: ListedPlugin): string {
  const id = p.installation?.identity;
  if (id?.registry?.id) return id.registry.id;
  if (id?.kind === "git" && id.remote) return id.remote;
  if (id?.kind === "npm" && id.packageName) return `npm:${id.packageName}`;
  return p.path ?? p.id;
}

export async function listPlugins(host: string, timeoutMs = 20_000): Promise<Record<string, Installed>> {
  const list = JSON.parse(await paseo(host, ["plugin", "ls", "--json"], timeoutMs)) as ListedPlugin[];
  const out: Record<string, Installed> = {};
  for (const p of list) out[p.id] = { source: sourceOf(p), enabled: p.enabled !== false };
  return out;
}

function flatten(obj: unknown, prefix = "", out: Record<string, unknown> = {}) {
  if (obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).length) {
    for (const [k, v] of Object.entries(obj)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else if (prefix) out[prefix] = obj;
  return out;
}

/** Flattened config.json of the environment, or null when it cannot be read from here. */
export async function readConfig(host: string): Promise<Record<string, unknown> | null> {
  const run = paseoOnMachine(host, ["daemon", "config", "get"]);
  if (!run) return null;
  const res = JSON.parse(await run) as { value: unknown };
  return flatten(res.value);
}
