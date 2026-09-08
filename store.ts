// Filesystem side: config file, Pi's own compaction settings, per-session state.json, spill snapshots.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { piCompactionFrom, type PiCompaction } from "./budget.ts";
import { DEFAULTS, mergeConfig, type Config } from "./config.ts";
import type { Elided, Kind, Spill } from "./archive.ts";
import { emptyScratch } from "./pin.ts";
import { newState, type PlanState } from "./plan.ts";

// Same resolution as Pi's getAgentDir().
export function agentDir(): string {
  const env = process.env.PI_CODING_AGENT_DIR;
  if (!env) return join(homedir(), ".pi", "agent");
  return env === "~" || env.startsWith("~/") ? join(homedir(), env.slice(1)) : env;
}

export const SPILL_ROOT = join(agentDir(), "context-budget");

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (err) {
    console.error(`context-budget: ignoring ${path}: ${err instanceof Error ? err.message : err}`);
  }
  return undefined;
}

export function loadConfig(): Config {
  const path = process.env.CONTEXT_BUDGET_CONFIG ?? join(agentDir(), "context-budget.json");
  const raw = readJson(path);
  return raw ? mergeConfig(raw) : { ...DEFAULTS };
}

// Pi's compaction block: global settings.json with the project's .pi/settings.json merged over it,
// the same precedence Pi's SettingsManager applies.
export function loadPiCompaction(cwd?: string): PiCompaction {
  const globals = readJson(join(agentDir(), "settings.json"))?.compaction;
  const project = cwd ? readJson(join(cwd, ".pi", "settings.json"))?.compaction : undefined;
  const merged = { ...(globals as object | undefined), ...(project as object | undefined) };
  return piCompactionFrom({ compaction: merged });
}

export function sessionDir(sessionId: string): string {
  return join(SPILL_ROOT, sessionId);
}

function statePath(sessionId: string): string {
  return join(sessionDir(sessionId), "state.json");
}

function kindFor(key: string, e: Partial<Elided>): Kind {
  if (e.kind === "result" || e.kind === "thinking" || e.kind === "arg") return e.kind;
  return key.startsWith("think:") ? "thinking" : key.startsWith("arg:") ? "arg" : "result";
}

// Reads 0.2 state too: entries gain a kind, the positional thinkCut is dropped (thinking is now keyed by content).
export function loadState(sessionId: string): PlanState {
  try {
    const p = statePath(sessionId);
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8")) as { elided?: Record<string, Partial<Elided>>; gen?: number; scratch?: PlanState["scratch"] };
      const elided: Record<string, Elided> = {};
      for (const [k, e] of Object.entries(raw.elided ?? {})) {
        if (!e || typeof e.id !== "string") continue;
        elided[k] = { id: e.id, kind: kindFor(k, e), path: e.path, step: e.step ?? 0, tool: e.tool ?? "tool", tokens: e.tokens ?? 0, duplicateOf: e.duplicateOf };
      }
      return { elided, gen: raw.gen ?? 0, scratch: raw.scratch ?? emptyScratch() };
    }
  } catch (err) {
    console.error(`context-budget: ignoring ${statePath(sessionId)}: ${err instanceof Error ? err.message : err}`);
  }
  return newState();
}

export function saveState(sessionId: string, state: PlanState): void {
  try {
    mkdirSync(sessionDir(sessionId), { recursive: true, mode: 0o700 });
    writeFileSync(statePath(sessionId), JSON.stringify(state), { mode: 0o600 });
  } catch (err) {
    console.error(`context-budget: could not persist state: ${err instanceof Error ? err.message : err}`);
  }
}

export function readSpill(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "");

// Snapshot file: <step>-<tool>-<key tail>.txt, 0600, never overwritten.
export function spillFor(sessionId: string): Spill {
  return (key, tool, step, text) => {
    try {
      const dir = sessionDir(sessionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const slug = safe(key).slice(-12) || "x";
      const path = join(dir, `${String(step).padStart(3, "0")}-${safe(tool).slice(0, 40) || "tool"}-${slug}.txt`);
      if (!existsSync(path)) writeFileSync(path, text, { mode: 0o600 });
      return path;
    } catch {
      return undefined;
    }
  };
}
