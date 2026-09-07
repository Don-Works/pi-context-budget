// context-budget: pure planning logic. No Pi imports so it runs under plain node
// (`node plan.ts` works on node >= 23 via built-in type stripping) and the replay
// harness exercises exactly the code the extension ships.
//
// Lossless for anything the model might need again: originals are snapshotted to
// an addressable archive and the prompt keeps a citation (id + head/tail). User
// text and assistant text/tool-calls are never altered. Thinking older than
// keepThinkingSteps is dropped from the prompt (it is billed on every resend)
// but archived under th-<step> like tool results.
//
// The plan only ever grows and advances in batches, so the serialized prefix
// sent to the provider stays byte-identical between advances (vLLM prefix cache).
// If the frozen view is still above targetFraction, a squeeze pass elides more
// (including recent/protected results) until we are at or below the cap — one
// extra prefix miss, instead of Pi asking a reasoning model to summarise.

export interface Config {
  enabled: boolean;
  startAtFraction: number;      // do nothing below this fraction of the context window
  highWaterFraction: number;    // above this, advance the plan as soon as anything is eligible
  targetFraction: number;       // squeeze target, used only when squeeze is on
  keepRecentSteps: number;      // tool results younger than this (assistant steps) are untouched
  keepThinkingSteps: number;    // thinking kept for this many most recent assistant steps
  minResultTokens: number;      // smaller tool results are never elided
  batchTokens: number;          // advance the plan only when >= this many tokens can be elided
  thinkBatchSteps: number;      // ...or when this many thinking blocks became eligible
  protectLatestReadTokens: number; // budget for keeping the latest un-superseded read per path
  stubHeadChars: number;        // citation keeps this many leading chars of the original
  stubTailChars: number;        // ...and this many trailing chars (errors live in the tail)
  recallLimitChars: number;     // default chunk size for addressable recall
  emergencyKeepSteps: number;   // squeeze never leaves fewer than this many recent result steps, unless still over cap
  emergencyKeepThinking: number;// squeeze drops thinking to this many recent steps
  scratchLimitChars: number;    // hard cap for the session pin
  squeeze: boolean;             // off by default: emergency elide down to targetFraction
  pin: boolean;                 // off by default: trailing session goal pin
  interceptCompact: boolean;    // off by default: replace Pi LLM compaction with a deterministic index
  charsPerToken: number;
}

export const DEFAULTS: Config = {
  enabled: true,
  startAtFraction: 0.3,
  highWaterFraction: 0.6,
  targetFraction: 0.6,
  keepRecentSteps: 8,
  keepThinkingSteps: 6,
  minResultTokens: 600,
  batchTokens: 6000,
  thinkBatchSteps: 4,
  protectLatestReadTokens: 12000,
  stubHeadChars: 400,
  stubTailChars: 400,
  recallLimitChars: 24000,
  emergencyKeepSteps: 2,
  emergencyKeepThinking: 1,
  scratchLimitChars: 1500,
  squeeze: false,
  pin: false,
  interceptCompact: true,
  charsPerToken: 3.3,
};

export interface Elided {
  id: string;           // cb-<tail> or th-<step> — stable, used by the recall tool
  path?: string;        // spill file, if the host wrote one
  step: number;
  tool: string;         // tool name, or "thinking"
  tokens: number;
  duplicateOf?: string; // archive id of the later identical call, if any
}

export interface Scratch {
  goal: string;
  notes: string;
}

export function emptyScratch(): Scratch {
  return { goal: "", notes: "" };
}

export interface PlanState {
  elided: Record<string, Elided>; // keyed by toolCallId, or "think:<step>"
  thinkCut: number; // thinking dropped for assistant steps with index < thinkCut
  gen: number;      // increments on every advance (each one invalidates the provider prefix cache once)
  scratch: Scratch;
}

export function newState(): PlanState {
  return { elided: {}, thinkCut: 0, gen: 0, scratch: emptyScratch() };
}

export interface Stats {
  ctxBefore: number;
  ctxAfter: number;
  advanced: boolean;
  squeezed: boolean;
  elidedTotal: number;
  thinkingDropped: number;
  resultsElided: number;
  eligibleWaiting: number;
}

export type Spill = (id: string, tool: string, step: number, text: string) => string | undefined;

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Msg = { role: string; content?: string | Block[]; toolCallId?: string; toolName?: string; isError?: boolean; details?: unknown; [k: string]: unknown };

export function estimate(text: string, cfg: Config): number {
  return Math.ceil(text.length / cfg.charsPerToken);
}

export function archiveId(toolCallId: string): string {
  const tail = toolCallId.replace(/[^A-Za-z0-9]/g, "").slice(-8) || "x";
  return `cb-${tail}`;
}

export function thinkId(step: number): string {
  return `th-${step}`;
}

export function sliceArchive(
  text: string,
  offset = 0,
  limit = DEFAULTS.recallLimitChars,
): { body: string; offset: number; next: number | null; total: number } {
  const o = Math.max(0, Math.min(offset, text.length));
  const n = Math.max(1, limit);
  const body = text.slice(o, o + n);
  const end = o + body.length;
  return { body, offset: o, next: end < text.length ? end : null, total: text.length };
}

export function formatCatalog(state: PlanState): string {
  const rows = Object.values(state.elided)
    .sort((a, b) => a.step - b.step || a.id.localeCompare(b.id))
    .map((e) => {
      const dup = e.duplicateOf ? ` dup=${e.duplicateOf}` : "";
      const path = e.path ? ` ${e.path}` : "";
      return `${e.id}\t${e.tool}\tstep ${e.step}\t${e.tokens} tok${dup}${path}`;
    });
  return rows.length ? rows.join("\n") : "archive empty";
}

export function findElided(state: PlanState, id: string): Elided | undefined {
  if (state.elided[id]) return state.elided[id];
  return Object.values(state.elided).find((e) => e.id === id);
}

function textOf(m: Msg): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  let out = "";
  for (const b of c) {
    if (b.type === "text") out += b.text ?? "";
    else if (b.type === "thinking") out += b.thinking ?? "";
    else if (b.type === "toolCall") out += JSON.stringify(b.arguments ?? {});
    else if (b.type === "image") out += " ".repeat(4800);
  }
  return out;
}

function resultText(m: Msg): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b) => (b.type === "text" ? b.text ?? "" : b.type === "image" ? " ".repeat(4800) : "")).join("");
}

function thinkingText(m: Msg): string {
  if (!Array.isArray(m.content)) return "";
  return m.content.filter((b) => b.type === "thinking").map((b) => b.thinking ?? "").join("\n");
}

export interface ResultInfo {
  idx: number;
  id: string;
  tool: string;
  step: number;
  tokens: number;
  path?: string;
  isError: boolean;
  sig: string;
}

function callSig(tool: string, args?: Record<string, unknown>): string {
  try {
    return `${tool}\n${JSON.stringify(args ?? {})}`;
  } catch {
    return tool;
  }
}

function indexResults(messages: Msg[]): { results: ResultInfo[]; nSteps: number } {
  const callStep = new Map<string, { step: number; path?: string; name: string; sig: string }>();
  const results: ResultInfo[] = [];
  let step = -1;
  messages.forEach((m, idx) => {
    if (m.role === "assistant") {
      step++;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === "toolCall" && b.id) {
          const name = b.name ?? "tool";
          callStep.set(b.id, { step, path: pathArg(b.arguments), name, sig: callSig(name, b.arguments) });
        }
      }
    } else if (m.role === "toolResult" && m.toolCallId) {
      const call = callStep.get(m.toolCallId);
      results.push({
        idx,
        id: m.toolCallId,
        tool: m.toolName ?? call?.name ?? "tool",
        step: call?.step ?? Math.max(step, 0),
        path: call?.path,
        tokens: 0,
        isError: !!m.isError,
        sig: call?.sig ?? callSig(m.toolName ?? "tool"),
      });
    }
  });
  return { results, nSteps: step + 1 };
}

function pathArg(a?: Record<string, unknown>): string | undefined {
  const p = a?.path;
  return typeof p === "string" ? p : undefined;
}

function latestBySig(results: ResultInfo[]): Map<string, string> {
  const latest = new Map<string, string>();
  for (const r of results) latest.set(r.sig, r.id);
  return latest;
}

// Latest un-superseded read per path, newest first, within the protection budget.
function protectedReads(messages: Msg[], results: ResultInfo[], cfg: Config): Set<string> {
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

export function headTail(text: string, headChars: number, tailChars: number): { head: string; tail: string; omitted: number } {
  const headN = Math.max(0, headChars);
  const tailN = Math.max(0, tailChars);
  if (text.length <= headN + tailN) return { head: text, tail: "", omitted: 0 };
  return { head: text.slice(0, headN), tail: text.slice(-tailN), omitted: text.length - headN - tailN };
}

function citationOverhead(cfg: Config): number {
  return estimate("x".repeat(cfg.stubHeadChars + cfg.stubTailChars + 280), cfg);
}

export function stubFor(r: ResultInfo, text: string, e: Elided, cfg: Config): string {
  const lines = text.split("\n").length;
  const { head, tail, omitted } = headTail(text, cfg.stubHeadChars, cfg.stubTailChars);
  const where = e.path
    ? `Snapshot at ${e.path}.`
    : "Snapshot was not written; recall may be unavailable.";
  const dup = e.duplicateOf ? ` Exact duplicate of a later ${r.tool} (${e.duplicateOf}, same arguments).` : "";
  const target = `Recall with context_budget_recall id=${e.id} (do not re-run the tool — the world may have changed).`;
  const readHint = r.tool === "read"
    ? ` This is the file as of step ${r.step}; re-read ${r.path ?? "the path"} only if you want the current disk contents.`
    : "";
  const err = r.isError ? " error=true" : "";
  const preview = omitted > 0
    ? `Head:\n${head}\n… ${omitted} chars omitted …\nTail:\n${tail}`
    : `Body:\n${head}`;
  return `[context-budget] id=${e.id}  ${r.tool}${r.path ? " " + r.path : ""}  step ${r.step}  ${r.tokens} tokens, ${lines} lines${err}\n${preview}\n${where}${dup} ${target}${readHint}`;
}

export function plan(messages: Msg[], state: PlanState, cfg: Config, contextWindow: number, spill: Spill): { messages: Msg[]; stats: Stats } {
  const { results, nSteps } = indexResults(messages);
  for (const r of results) r.tokens = estimate(resultText(messages[r.idx]), cfg);
  const ctxBefore = messages.reduce((n, m) => n + estimate(textOf(m), cfg) + 8, 0);
  const ctxFrozen = ctxBefore - frozenSavings(messages, results, state, cfg);
  const stats: Stats = { ctxBefore, ctxAfter: ctxFrozen, advanced: false, squeezed: false, elidedTotal: 0, thinkingDropped: 0, resultsElided: 0, eligibleWaiting: 0 };
  const overhead = citationOverhead(cfg);
  const latest = latestBySig(results);

  if (cfg.enabled && ctxFrozen >= cfg.startAtFraction * contextWindow) {
    const protect = protectedReads(messages, results, cfg);
    const cands = results.filter((r) => !state.elided[r.id] && nSteps - 1 - r.step >= cfg.keepRecentSteps && r.tokens > cfg.minResultTokens && !protect.has(r.id));
    const candTokens = cands.reduce((n, r) => n + Math.max(0, r.tokens - overhead), 0);
    const thinkTarget = Math.max(0, nSteps - cfg.keepThinkingSteps);
    const thinkCands = thinkTarget - state.thinkCut;
    const hot = ctxFrozen >= cfg.highWaterFraction * contextWindow;
    stats.eligibleWaiting = candTokens;
    if (candTokens >= cfg.batchTokens || thinkCands >= cfg.thinkBatchSteps || (hot && (cands.length > 0 || thinkCands > 0))) {
      archiveResults(cands, messages, state, latest, spill);
      archiveThinking(messages, state, state.thinkCut, thinkTarget, spill, cfg);
      state.thinkCut = Math.max(state.thinkCut, thinkTarget);
      state.gen++;
      stats.advanced = true;
      stats.eligibleWaiting = 0;
    }
  }

  if (cfg.enabled && cfg.squeeze && projectedCtx(messages, results, state, cfg) > cfg.targetFraction * contextWindow) {
    if (squeeze(messages, results, state, cfg, contextWindow, spill, nSteps, latest)) {
      if (!stats.advanced) state.gen++;
      stats.advanced = true;
      stats.squeezed = true;
      stats.eligibleWaiting = 0;
    }
  }

  const out = apply(messages, results, state, cfg, stats);
  stats.ctxAfter = out.reduce((n, m) => n + estimate(textOf(m), cfg) + 8, 0);
  stats.elidedTotal = ctxBefore - stats.ctxAfter;
  return { messages: out, stats };
}

function archiveResults(cands: ResultInfo[], messages: Msg[], state: PlanState, latest: Map<string, string>, spill: Spill): void {
  for (const r of cands) {
    if (state.elided[r.id]) continue;
    const text = resultText(messages[r.idx]);
    const id = archiveId(r.id);
    const path = spill(r.id, r.tool, r.step, text);
    const later = latest.get(r.sig);
    const dup = later && later !== r.id ? archiveId(later) : undefined;
    state.elided[r.id] = { id, path, step: r.step, tool: r.tool, tokens: r.tokens, duplicateOf: dup };
  }
}

function projectedCtx(messages: Msg[], results: ResultInfo[], state: PlanState, cfg: Config): number {
  const before = messages.reduce((n, m) => n + estimate(textOf(m), cfg) + 8, 0);
  return before - frozenSavings(messages, results, state, cfg);
}

function squeeze(
  messages: Msg[],
  results: ResultInfo[],
  state: PlanState,
  cfg: Config,
  contextWindow: number,
  spill: Spill,
  nSteps: number,
  latest: Map<string, string>,
): boolean {
  const target = cfg.targetFraction * contextWindow;
  const over = () => projectedCtx(messages, results, state, cfg) > target;
  if (!over()) return false;
  let changed = false;

  const thinkTarget = Math.max(0, nSteps - Math.max(0, cfg.emergencyKeepThinking));
  if (thinkTarget > state.thinkCut) {
    archiveThinking(messages, state, state.thinkCut, thinkTarget, spill, cfg);
    state.thinkCut = thinkTarget;
    changed = true;
  }

  const elideMatching = (pred: (r: ResultInfo) => boolean, newestFirst: boolean) => {
    const cands = results.filter((r) => !state.elided[r.id] && r.tokens > 80 && pred(r));
    cands.sort((a, b) => (newestFirst ? b.tokens - a.tokens : a.step - b.step || b.tokens - a.tokens));
    for (const r of cands) {
      if (!over()) break;
      archiveResults([r], messages, state, latest, spill);
      changed = true;
    }
  };

  if (over()) elideMatching((r) => nSteps - 1 - r.step >= cfg.emergencyKeepSteps, false);
  if (over()) elideMatching(() => true, true);
  return changed;
}

function archiveThinking(messages: Msg[], state: PlanState, from: number, to: number, spill: Spill, cfg: Config): void {
  let step = -1;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    step++;
    if (step < from || step >= to) continue;
    const key = `think:${step}`;
    if (state.elided[key]) continue;
    const text = thinkingText(m);
    if (!text) continue;
    const tokens = estimate(text, cfg);
    const path = spill(key, "thinking", step, text);
    state.elided[key] = { id: thinkId(step), path, step, tool: "thinking", tokens };
  }
}

function frozenSavings(messages: Msg[], results: ResultInfo[], state: PlanState, cfg: Config): number {
  const overhead = citationOverhead(cfg);
  let saved = 0;
  for (const r of results) if (state.elided[r.id]) saved += Math.max(0, r.tokens - overhead);
  let step = -1;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    step++;
    if (step >= state.thinkCut) continue;
    for (const b of Array.isArray(m.content) ? m.content : []) if (b.type === "thinking") saved += estimate(b.thinking ?? "", cfg);
  }
  return saved;
}

function apply(messages: Msg[], results: ResultInfo[], state: PlanState, cfg: Config, stats: Stats): Msg[] {
  const byIdx = new Map(results.map((r) => [r.idx, r]));
  let step = -1;
  return messages.map((m, idx) => {
    if (m.role === "assistant") {
      step++;
      if (step >= state.thinkCut || !Array.isArray(m.content)) return m;
      const kept = m.content.filter((b) => b.type !== "thinking");
      if (kept.length === m.content.length) return m;
      stats.thinkingDropped += m.content.length - kept.length;
      return { ...m, content: kept };
    }
    if (m.role === "toolResult") {
      const r = byIdx.get(idx);
      const e = r && state.elided[r.id];
      if (!r || !e) return m;
      stats.resultsElided++;
      return { ...m, content: [{ type: "text", text: stubFor(r, resultText(m), e, cfg) }] };
    }
    return m;
  });
}

export const PIN_PREFIX = "[context-budget pin]";

export function isPinMessage(m: Msg): boolean {
  if (m.role !== "user") return false;
  const t = typeof m.content === "string" ? m.content : resultText(m);
  return t.startsWith(PIN_PREFIX);
}

export function stripPin(messages: Msg[]): Msg[] {
  if (!messages.length || !isPinMessage(messages[messages.length - 1])) return messages;
  return messages.slice(0, -1);
}

export function firstUserText(messages: Msg[]): string {
  for (const m of messages) {
    if (m.role !== "user" || isPinMessage(m)) continue;
    const t = (typeof m.content === "string" ? m.content : resultText(m)).trim();
    if (t) return t;
  }
  return "";
}

export function seedScratch(scratch: Scratch, messages: Msg[], cfg: Config): boolean {
  if (scratch.goal) return false;
  const first = firstUserText(messages);
  if (!first) return false;
  scratch.goal = clip(first, Math.min(500, cfg.scratchLimitChars));
  return true;
}

export function setScratch(scratch: Scratch, patch: { goal?: string; notes?: string }, cfg: Config): { ok: boolean; error?: string } {
  const next: Scratch = {
    goal: patch.goal != null ? patch.goal.trim() : scratch.goal,
    notes: patch.notes != null ? patch.notes.trim() : scratch.notes,
  };
  const body = `${next.goal}\n${next.notes}`.trim();
  if (body.length > cfg.scratchLimitChars) {
    return { ok: false, error: `pin is ${body.length} chars; cap is ${cfg.scratchLimitChars}. Shorten goal or notes.` };
  }
  scratch.goal = next.goal;
  scratch.notes = next.notes;
  return { ok: true };
}

export function formatPin(scratch: Scratch): string | undefined {
  if (!scratch.goal && !scratch.notes) return undefined;
  const lines = [`${PIN_PREFIX} Session working memory (not a new request). Continue the task.`];
  if (scratch.goal) lines.push(`Goal: ${scratch.goal}`);
  if (scratch.notes) lines.push(`Notes:\n${scratch.notes}`);
  return lines.join("\n");
}

function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}

export interface CompactInput {
  messagesToSummarize?: Msg[];
  turnPrefixMessages?: Msg[];
  previousSummary?: string;
  fileOps?: { read?: Iterable<string>; edited?: Iterable<string>; written?: Iterable<string>; readFiles?: string[]; modifiedFiles?: string[] };
  tokensBefore?: number;
  customInstructions?: string;
}

export function deterministicSummary(input: CompactInput, state: PlanState, cfg: Config): string {
  const users = [...(input.messagesToSummarize ?? []), ...(input.turnPrefixMessages ?? [])]
    .filter((m) => m.role === "user" && !isPinMessage(m))
    .map((m) => clip(typeof m.content === "string" ? m.content : resultText(m), 400))
    .filter(Boolean)
    .slice(0, 8);
  const { read, modified } = fileLists(input.fileOps);
  const archived = Object.values(state.elided).sort((a, b) => a.step - b.step || a.id.localeCompare(b.id));
  const toolRows = archived.filter((e) => e.tool !== "thinking").slice(0, 40);
  const thinkN = archived.filter((e) => e.tool === "thinking").length;
  const goal = state.scratch.goal || users[0] || "(not captured)";
  const lines: string[] = [
    "## Goal",
    goal,
    "",
    "## Constraints & Preferences",
    state.scratch.notes || "- (none pinned)",
    "",
    "## Progress",
    `- Context-budget archive: ${toolRows.length} tool snapshots, ${thinkN} thinking snapshots, plan generation ${state.gen}.`,
    "- Originals are on disk; recall with context_budget_recall id=<cb-… or th-…>. Do not re-run tools for historical output.",
    "",
    "## User asks in the compacted span",
    ...(users.length ? users.map((u) => `- ${u}`) : ["- (none)"]),
    "",
    "## Key Decisions",
    "- Compaction is lossless at the archive: this summary is an index, not a paraphrase of tool output.",
    "",
    "## Next Steps",
    "1. Continue from the kept recent messages after this summary.",
    "2. Recall an archive id if a compacted tool result is needed verbatim.",
    "",
    "## Critical Context",
    `- tokensBefore ${input.tokensBefore ?? "?"}`,
    input.previousSummary ? `- Previous compaction summary (head): ${clip(input.previousSummary, 600)}` : "- No previous compaction summary.",
  ];
  if (input.customInstructions) lines.push(`- Custom instructions: ${clip(input.customInstructions, 300)}`);
  if (toolRows.length) {
    lines.push("", "## Archive");
    for (const e of toolRows) lines.push(`- ${e.id}  ${e.tool}  step ${e.step}  ${e.tokens} tok`);
    if (archived.filter((e) => e.tool !== "thinking").length > toolRows.length) {
      lines.push(`- … ${archived.filter((e) => e.tool !== "thinking").length - toolRows.length} more; context_budget_recall list=true`);
    }
  }
  if (read.length) {
    lines.push("", "<read-files>");
    for (const p of read.slice(0, 40)) lines.push(p);
    lines.push("</read-files>");
  }
  if (modified.length) {
    lines.push("", "<modified-files>");
    for (const p of modified.slice(0, 40)) lines.push(p);
    lines.push("</modified-files>");
  }
  const text = lines.join("\n");
  const cap = 8000;
  return text.length <= cap ? text : text.slice(0, cap) + "\n… (index truncated)";
}

function fileLists(fileOps: CompactInput["fileOps"]): { read: string[]; modified: string[] } {
  if (!fileOps) return { read: [], modified: [] };
  const asArr = (v?: Iterable<string> | string[]) => (v ? [...v] : []);
  const modified = unique([...asArr(fileOps.edited), ...asArr(fileOps.written), ...asArr(fileOps.modifiedFiles)]);
  const read = unique(asArr(fileOps.read).length ? asArr(fileOps.read) : asArr(fileOps.readFiles)).filter((p) => !modified.includes(p));
  return { read, modified };
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}
