// context-budget: pure planning logic. No Pi imports so it runs under plain node
// (`node plan.ts` works on node >= 23 via built-in type stripping) and the replay
// harness exercises exactly the code the extension ships.
//
// Two levers, both lossless for the model's own words:
//   1. thinking blocks of assistant steps older than keepThinkingSteps are dropped
//   2. tool results older than keepRecentSteps and larger than minResultTokens are
//      replaced by a stub that says what was elided and where the full text lives
// The plan only ever grows and advances in batches, so the serialized prefix sent
// to the provider stays byte-identical between advances (vLLM prefix cache hits).

export interface Config {
  enabled: boolean;
  startAtFraction: number;      // do nothing below this fraction of the context window
  highWaterFraction: number;    // above this, advance the plan as soon as anything is eligible
  keepRecentSteps: number;      // tool results younger than this (assistant steps) are untouched
  keepThinkingSteps: number;    // thinking kept for this many most recent assistant steps
  minResultTokens: number;      // smaller tool results are never elided
  batchTokens: number;          // advance the plan only when >= this many tokens can be elided
  thinkBatchSteps: number;      // ...or when this many thinking blocks became eligible
  protectLatestReadTokens: number; // budget for keeping the latest un-superseded read per path
  errorHeadChars: number;       // error results keep this much of their head
  charsPerToken: number;
}

export const DEFAULTS: Config = {
  enabled: true,
  startAtFraction: 0.3,
  highWaterFraction: 0.6,
  keepRecentSteps: 8,
  keepThinkingSteps: 6,
  minResultTokens: 600,
  batchTokens: 6000,
  thinkBatchSteps: 4,
  protectLatestReadTokens: 12000,
  errorHeadChars: 400,
  charsPerToken: 3.3,
};

export interface PlanState {
  elided: Record<string, { path?: string; step: number; tool: string; tokens: number }>;
  thinkCut: number; // thinking dropped for assistant steps with index < thinkCut
  gen: number;      // increments on every advance (each one invalidates the provider prefix cache once)
}

export function newState(): PlanState {
  return { elided: {}, thinkCut: 0, gen: 0 };
}

export interface Stats {
  ctxBefore: number;
  ctxAfter: number;
  advanced: boolean;
  elidedTotal: number;
  thinkingDropped: number;
  resultsElided: number;
  eligibleWaiting: number;
}

export type Spill = (toolCallId: string, tool: string, step: number, text: string) => string | undefined;

type Block = { type: string; text?: string; thinking?: string; id?: string; name?: string; arguments?: Record<string, unknown> };
type Msg = { role: string; content?: string | Block[]; toolCallId?: string; toolName?: string; isError?: boolean; details?: unknown; [k: string]: unknown };

export function estimate(text: string, cfg: Config): number {
  return Math.ceil(text.length / cfg.charsPerToken);
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

interface ResultInfo { idx: number; id: string; tool: string; step: number; tokens: number; path?: string; isError: boolean }

function indexResults(messages: Msg[]): { results: ResultInfo[]; nSteps: number } {
  const callStep = new Map<string, { step: number; path?: string }>();
  const results: ResultInfo[] = [];
  let step = -1;
  messages.forEach((m, idx) => {
    if (m.role === "assistant") {
      step++;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (b.type === "toolCall" && b.id) callStep.set(b.id, { step, path: pathArg(b.arguments) });
      }
    } else if (m.role === "toolResult" && m.toolCallId) {
      const call = callStep.get(m.toolCallId);
      results.push({ idx, id: m.toolCallId, tool: m.toolName ?? "tool", step: call?.step ?? Math.max(step, 0), path: call?.path, tokens: 0, isError: !!m.isError });
    }
  });
  return { results, nSteps: step + 1 };
}

function pathArg(a?: Record<string, unknown>): string | undefined {
  const p = a?.path;
  return typeof p === "string" ? p : undefined;
}

// Latest un-superseded read per path, newest first, within the protection budget.
function protectedReads(messages: Msg[], results: ResultInfo[], cfg: Config): Set<string> {
  const latestByPath = new Map<string, ResultInfo>();
  for (const r of results) if (r.tool === "read" && r.path) latestByPath.set(r.path, r);
  // a later edit/write of the same path supersedes the read
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

export function stubFor(r: ResultInfo, text: string, spillPath: string | undefined, cfg: Config): string {
  const lines = text.split("\n").length;
  const first = (text.split("\n").find((l) => l.trim().length > 0) ?? "").slice(0, 100);
  if (r.tool === "read") {
    return `[context-budget] Elided read of ${r.path ?? "file"} from step ${r.step} (${r.tokens} tokens). Re-read the file if you need its contents again.`;
  }
  const where = spillPath ? `Full output saved at ${spillPath} (read it only if you need it again).` : "Re-run the tool if you need it again.";
  const head = r.isError ? `${text.slice(0, cfg.errorHeadChars)}\n… ` : "";
  return `${head}[context-budget] Elided ${r.tool} output from step ${r.step} (${r.tokens} tokens, ${lines} lines). Began: "${first}". ${where}`;
}

export function plan(messages: Msg[], state: PlanState, cfg: Config, contextWindow: number, spill: Spill): { messages: Msg[]; stats: Stats } {
  const { results, nSteps } = indexResults(messages);
  for (const r of results) r.tokens = estimate(resultText(messages[r.idx]), cfg);
  const ctxBefore = messages.reduce((n, m) => n + estimate(textOf(m), cfg) + 8, 0);
  const ctxFrozen = ctxBefore - frozenSavings(messages, results, state, cfg);
  const stats: Stats = { ctxBefore, ctxAfter: ctxFrozen, advanced: false, elidedTotal: 0, thinkingDropped: 0, resultsElided: 0, eligibleWaiting: 0 };

  if (cfg.enabled && ctxFrozen >= cfg.startAtFraction * contextWindow) {
    const protect = protectedReads(messages, results, cfg);
    const cands = results.filter((r) => !state.elided[r.id] && nSteps - 1 - r.step >= cfg.keepRecentSteps && r.tokens > cfg.minResultTokens && !protect.has(r.id));
    const candTokens = cands.reduce((n, r) => n + r.tokens - 60, 0);
    const thinkTarget = Math.max(0, nSteps - cfg.keepThinkingSteps);
    const thinkCands = thinkTarget - state.thinkCut;
    const hot = ctxFrozen >= cfg.highWaterFraction * contextWindow;
    stats.eligibleWaiting = candTokens;
    if (candTokens >= cfg.batchTokens || thinkCands >= cfg.thinkBatchSteps || (hot && (cands.length > 0 || thinkCands > 0))) {
      for (const r of cands) {
        const text = resultText(messages[r.idx]);
        const path = r.tool === "read" ? undefined : spill(r.id, r.tool, r.step, text);
        state.elided[r.id] = { path, step: r.step, tool: r.tool, tokens: r.tokens };
      }
      state.thinkCut = Math.max(state.thinkCut, thinkTarget);
      state.gen++;
      stats.advanced = true;
      stats.eligibleWaiting = 0;
    }
  }

  const out = apply(messages, results, state, cfg, stats);
  stats.ctxAfter = out.reduce((n, m) => n + estimate(textOf(m), cfg) + 8, 0);
  stats.elidedTotal = ctxBefore - stats.ctxAfter;
  return { messages: out, stats };
}

function frozenSavings(messages: Msg[], results: ResultInfo[], state: PlanState, cfg: Config): number {
  let saved = 0;
  for (const r of results) if (state.elided[r.id]) saved += Math.max(0, r.tokens - 60);
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
      return { ...m, content: [{ type: "text", text: stubFor(r, resultText(m), e.path, cfg) }] };
    }
    return m;
  });
}
