// Message shapes and indexing. Pure; no Pi imports.
import { estimate, type Config } from "./config.ts";
import { argKey, thinkKey, thinkId, type Elided } from "./archive.ts";

export type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
export type Msg = {
  role: string;
  content?: string | Block[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  summary?: string;   // compactionSummary / branchSummary
  output?: string;    // bashExecution
  details?: unknown;
  [k: string]: unknown;
};

const IMAGE_CHARS = 4800;

export function textOf(m: Msg): string {
  const c = m.content;
  let out = typeof m.summary === "string" ? m.summary : typeof m.output === "string" ? m.output : "";
  if (typeof c === "string") return out + c;
  if (!Array.isArray(c)) return out;
  for (const b of c) {
    if (b.type === "text") out += b.text ?? "";
    else if (b.type === "thinking") out += b.thinking ?? "";
    else if (b.type === "toolCall") out += stringifyArgs(b.arguments);
    else if (b.type === "image") out += " ".repeat(IMAGE_CHARS);
  }
  return out;
}

function stringifyArgs(args?: Record<string, unknown>): string {
  try { return JSON.stringify(args ?? {}); } catch { return ""; }
}

export function resultText(m: Msg): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");
}

export function hasImage(m: Msg): boolean {
  return Array.isArray(m.content) && m.content.some((b) => b.type === "image");
}

export function thinkingText(m: Msg): string {
  if (!Array.isArray(m.content)) return "";
  return m.content.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("\n");
}

export function estimateMessages(messages: Msg[], cfg: Config): number {
  return messages.reduce((n, m) => n + estimate(textOf(m), cfg) + 8, 0);
}

export interface ResultInfo {
  idx: number;
  id: string;        // toolCallId; also the state key
  tool: string;
  step: number;
  tokens: number;
  path?: string;
  isError: boolean;
  hasImage: boolean;
  sig: string;
}

export interface ArgInfo {
  idx: number;
  bi: number;        // block index inside the assistant message
  key: string;       // arg:<toolCallId>:<name>
  callId: string;
  name: string;
  tool: string;
  step: number;
  tokens: number;
  ordinal: number;   // nth large argument of this call
}

export interface ThinkInfo {
  idx: number;
  key: string;       // think:<hash>
  id: string;
  step: number;
  tokens: number;
}

export interface Index {
  results: ResultInfo[];
  args: ArgInfo[];
  thinks: ThinkInfo[];
  nSteps: number;
}

function callSig(tool: string, args?: Record<string, unknown>): string {
  return `${tool}\n${stringifyArgs(args)}`;
}

export function pathArg(a?: Record<string, unknown>): string | undefined {
  const p = a?.path;
  return typeof p === "string" ? p : undefined;
}

export function indexMessages(messages: Msg[], cfg: Config): Index {
  const calls = new Map<string, { step: number; path?: string; name: string; sig: string }>();
  const results: ResultInfo[] = [];
  const args: ArgInfo[] = [];
  const thinks: ThinkInfo[] = [];
  let step = -1;
  messages.forEach((m, idx) => {
    if (m.role === "assistant") {
      step++;
      const think = thinkingText(m);
      if (think) thinks.push({ idx, key: thinkKey(think), id: thinkId(thinkKey(think).slice(6)), step, tokens: estimate(think, cfg) });
      indexCalls(m, idx, step, cfg, calls, args);
    } else if (m.role === "toolResult" && m.toolCallId) {
      const call = calls.get(m.toolCallId);
      const tool = m.toolName ?? call?.name ?? "tool";
      results.push({
        idx, id: m.toolCallId, tool,
        step: call?.step ?? Math.max(step, 0),
        path: call?.path,
        tokens: estimate(resultText(m), cfg),
        isError: !!m.isError,
        hasImage: hasImage(m),
        sig: call?.sig ?? callSig(tool),
      });
    }
  });
  return { results, args, thinks, nSteps: step + 1 };
}

function indexCalls(m: Msg, idx: number, step: number, cfg: Config, calls: Map<string, { step: number; path?: string; name: string; sig: string }>, args: ArgInfo[]): void {
  if (!Array.isArray(m.content)) return;
  m.content.forEach((b, bi) => {
    if (b.type !== "toolCall" || !b.id) return;
    const name = b.name ?? "tool";
    calls.set(b.id, { step, path: pathArg(b.arguments), name, sig: callSig(name, b.arguments) });
    if (!(cfg.argMinTokens > 0) || !b.arguments || typeof b.arguments !== "object") return;
    let ordinal = 0;
    for (const [k, v] of Object.entries(b.arguments)) {
      if (typeof v !== "string") continue;
      const tokens = estimate(v, cfg);
      if (tokens <= cfg.argMinTokens) continue;
      args.push({ idx, bi, key: argKey(b.id, k), callId: b.id, name: k, tool: name, step, tokens, ordinal: ordinal++ });
    }
  });
}

export function latestBySig(results: ResultInfo[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const r of results) latest.set(r.sig, r.id);
  return latest;
}

// Latest un-superseded read per path, newest first, within the protection budget.
export function protectedReads(messages: Msg[], results: ResultInfo[], cfg: Config): Set<string> {
  const latestByPath = new Map<string, ResultInfo>();
  for (const r of results) if (r.tool === "read" && r.path) latestByPath.set(r.path, r);
  let step = -1;
  const superseded = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    step++;
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (b.type !== "toolCall" || (b.name !== "edit" && b.name !== "write")) continue;
      const p = pathArg(b.arguments);
      const r = p ? latestByPath.get(p) : undefined;
      if (r && r.step < step) superseded.add(r.id);
    }
  }
  const keep = new Set<string>();
  let budget = cfg.protectLatestReadTokens;
  for (const r of [...latestByPath.values()].sort((a, b) => b.step - a.step)) {
    if (superseded.has(r.id) || r.tokens > budget) continue;
    keep.add(r.id);
    budget -= r.tokens;
  }
  return keep;
}

export function argText(messages: Msg[], a: ArgInfo): string {
  const b = (messages[a.idx].content as Block[])[a.bi];
  const v = b?.arguments?.[a.name];
  return typeof v === "string" ? v : "";
}

export type ElidedMap = Record<string, Elided>;
