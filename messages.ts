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
  name: string;      // access path: "content", or "edits[0].oldText" when nested
  segs: (string | number)[]; // the same path, resolved
  filePath?: string; // the call's target file, when it names one
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
    const filePath = pathArg(b.arguments);
    calls.set(b.id, { step, path: filePath, name, sig: callSig(name, b.arguments) });
    if (!(cfg.argMinTokens > 0) || !b.arguments || typeof b.arguments !== "object") return;
    const leaves: { segs: (string | number)[]; text: string }[] = [];
    stringLeaves(b.arguments, [], 0, leaves);
    let ordinal = 0;
    for (const leaf of leaves) {
      const tokens = estimate(leaf.text, cfg);
      if (tokens <= cfg.argMinTokens) continue;
      const path = argPathName(leaf.segs);
      args.push({ idx, bi, key: argKey(b.id, path), callId: b.id, name: path, segs: leaf.segs, filePath, tool: name, step, tokens, ordinal: ordinal++ });
    }
  });
}

// The biggest thing an editing session re-sends is not a top-level string: Pi's `edit` passes
// edits: [{oldText, newText}], and only walking the top level left every one of them in the
// prompt forever. Collect string leaves instead, bounded in depth so a pathological argument
// cannot make indexing quadratic.
const MAX_ARG_DEPTH = 4;

function stringLeaves(value: unknown, segs: (string | number)[], depth: number, out: { segs: (string | number)[]; text: string }[]): void {
  if (typeof value === "string") {
    if (segs.length) out.push({ segs, text: value });
    return;
  }
  if (depth >= MAX_ARG_DEPTH || value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((v, i) => stringLeaves(v, [...segs, i], depth + 1, out));
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) stringLeaves(v, [...segs, k], depth + 1, out);
}

export function argPathName(segs: (string | number)[]): string {
  return segs.map((s, i) => (typeof s === "number" ? `[${s}]` : i === 0 ? s : `.${s}`)).join("");
}

export function getAt(root: unknown, segs: (string | number)[]): unknown {
  let cur: unknown = root;
  for (const s of segs) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, unknown>)[s];
  }
  return cur;
}

// Immutable set: clones only the containers along the path, so untouched arguments keep their
// identity and the serialized prefix stays byte-identical where nothing was elided.
export function setAt<T>(root: T, segs: (string | number)[], value: unknown): T {
  if (!segs.length) return value as T;
  const [head, ...rest] = segs;
  const src = root as unknown;
  const clone: Record<string | number, unknown> = Array.isArray(src)
    ? ([...(src as unknown[])] as unknown as Record<string | number, unknown>)
    : { ...((src ?? {}) as Record<string | number, unknown>) };
  clone[head] = setAt(clone[head], rest, value);
  return clone as unknown as T;
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

// Archive ids the model has asked back. A recalled citation is never demoted to a one-line
// index entry: asking for the snapshot is the model saying it still wants that content.
export function recalledIds(messages: Msg[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type !== "toolCall" || b.name !== "context_budget_recall") continue;
      const id = b.arguments?.id;
      if (typeof id === "string") out.add(id);
    }
  }
  return out;
}

export function argText(messages: Msg[], a: ArgInfo): string {
  const b = (messages[a.idx].content as Block[])[a.bi];
  const v = getAt(b?.arguments, a.segs);
  return typeof v === "string" ? v : "";
}

export type ElidedMap = Record<string, Elided>;
