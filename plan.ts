// context-budget: pure planning logic. No Pi imports so it runs under plain node
// (node >= 23 type stripping) and the replay harness exercises exactly the code
// the extension ships.
//
// Lossless for anything the model might need again: originals are snapshotted to
// an addressable archive and the prompt keeps a citation (id + head/tail). User
// text and assistant text are never altered. Old tool results, large tool-call
// arguments and old thinking are archived; thinking is dropped from the prompt
// (it is billed on every resend), the other two leave a citation behind.
//
// The plan only ever grows and advances in batches, so the serialized prefix
// sent to the provider stays byte-identical between advances (vLLM prefix cache).
// If the frozen view is still above targetFraction, an opt-in squeeze pass elides
// more (including recent/protected results) until we are at or below the cap.
import { estimate, type Config } from "./config.ts";
import { RESULT_MIN_TOKENS_FLOOR, archiveId, argId, argStub, stubFor, type Elided, type Spill } from "./archive.ts";
import { argText, estimateMessages, indexMessages, latestBySig, protectedReads, resultText, thinkingText, type ArgInfo, type Block, type Index, type Msg, type ResultInfo, type ThinkInfo } from "./messages.ts";
import { emptyScratch, type Scratch } from "./pin.ts";

export { DEFAULTS, estimate, mergeConfig, type Config } from "./config.ts";
export * from "./archive.ts";
export * from "./pin.ts";
export * from "./summary.ts";
export { indexMessages, resultText, textOf, type Msg } from "./messages.ts";

export interface PlanState {
  elided: Record<string, Elided>; // keyed by toolCallId, "arg:<toolCallId>:<name>" or "think:<hash>"
  gen: number;                    // increments on every advance (each one moves the prefix-cache miss point once)
  scratch: Scratch;
}

export function newState(): PlanState {
  return { elided: {}, gen: 0, scratch: emptyScratch() };
}

export interface Stats {
  ctxBefore: number;
  ctxAfter: number;
  advanced: boolean;
  squeezed: boolean;
  elidedTotal: number;
  thinkingDropped: number;
  resultsElided: number;
  argsElided: number;
  eligibleWaiting: number;
}

interface Host {
  messages: Msg[];
  state: PlanState;
  cfg: Config;
  spill: Spill;
  latest: Map<string, string>;
  stubTokens: Map<string, number>; // exact citation size per item, memoized for this request
}

// baseTokens: prompt overhead the messages do not carry (system prompt, tool schemas).
export function plan(messages: Msg[], state: PlanState, cfg: Config, contextWindow: number, spill: Spill, baseTokens = 0): { messages: Msg[]; stats: Stats } {
  const ix = indexMessages(messages, cfg);
  const ctxBefore = baseTokens + estimateMessages(messages, cfg);
  const h: Host = { messages, state, cfg, spill, latest: latestBySig(ix.results), stubTokens: new Map() };
  const ctxFrozen = ctxBefore - frozenSavings(h, ix);
  const stats: Stats = { ctxBefore, ctxAfter: ctxFrozen, advanced: false, squeezed: false, elidedTotal: 0, thinkingDropped: 0, resultsElided: 0, argsElided: 0, eligibleWaiting: 0 };

  if (cfg.enabled && ctxFrozen >= cfg.startAtFraction * contextWindow) {
    if (advance(h, ix, ctxFrozen >= cfg.highWaterFraction * contextWindow, stats)) {
      state.gen++;
      stats.advanced = true;
    }
  }
  if (cfg.enabled && cfg.squeeze && squeeze(h, ix, cfg.targetFraction * contextWindow, ctxBefore)) {
    if (!stats.advanced) state.gen++;
    stats.advanced = true;
    stats.squeezed = true;
    stats.eligibleWaiting = 0;
  }

  const out = apply(h, ix, stats);
  stats.ctxAfter = baseTokens + estimateMessages(out, cfg);
  stats.elidedTotal = ctxBefore - stats.ctxAfter;
  return { messages: out, stats };
}

// Savings are measured against the citation that would actually be sent, so the squeeze cap is exact.
function resultSavings(h: Host, r: ResultInfo): number {
  let stub = h.stubTokens.get(r.id);
  if (stub == null) {
    const e = h.state.elided[r.id] ?? { ...entryFor(h, r), path: "pending" };
    stub = estimate(stubFor(r, resultText(h.messages[r.idx]), e, h.cfg), h.cfg);
    h.stubTokens.set(r.id, stub);
  }
  return Math.max(0, r.tokens - stub);
}

function argSavings(h: Host, a: ArgInfo): number {
  let stub = h.stubTokens.get(a.key);
  if (stub == null) {
    const e = h.state.elided[a.key] ?? entryForArg(a, "pending");
    stub = estimate(argStub(argText(h.messages, a), e, h.cfg), h.cfg);
    h.stubTokens.set(a.key, stub);
  }
  return Math.max(0, a.tokens - stub);
}

function entryFor(h: Host, r: ResultInfo, path?: string): Elided {
  const later = h.latest.get(r.sig);
  const duplicateOf = later && later !== r.id ? archiveId(later) : undefined;
  return { id: archiveId(r.id), kind: "result", path, step: r.step, tool: r.tool, tokens: r.tokens, duplicateOf };
}

function entryForArg(a: ArgInfo, path?: string): Elided {
  return { id: argId(a.callId, a.ordinal), kind: "arg", path, step: a.step, tool: `${a.tool}(${a.name})`, tokens: a.tokens };
}

function advance(h: Host, ix: Index, hot: boolean, stats: Stats): boolean {
  const { cfg, state } = h;
  const last = ix.nSteps - 1;
  const oldEnough = (step: number) => last - step >= Math.max(1, cfg.keepRecentSteps);
  const protect = protectedReads(h.messages, ix.results, cfg);
  const results = ix.results.filter((r) => !state.elided[r.id] && oldEnough(r.step) && r.tokens > cfg.minResultTokens && !protect.has(r.id) && !r.hasImage);
  const args = ix.args.filter((a) => !state.elided[a.key] && oldEnough(a.step));
  const thinks = ix.thinks.filter((t) => !state.elided[t.key] && last - t.step >= cfg.keepThinkingSteps);
  const tokens = results.reduce((n, r) => n + resultSavings(h, r), 0) + args.reduce((n, a) => n + argSavings(h, a), 0);
  stats.eligibleWaiting = tokens;
  const any = results.length + args.length + thinks.length > 0;
  if (!(tokens >= cfg.batchTokens || thinks.length >= cfg.thinkBatchSteps || (hot && any))) return false;
  for (const r of results) archiveResult(h, r);
  for (const a of args) archiveArg(h, a);
  for (const t of thinks) archiveThink(h, t);
  stats.eligibleWaiting = 0;
  return true;
}

// Never touches the latest assistant step: the model has not seen those results yet.
function squeeze(h: Host, ix: Index, target: number, ctxBefore: number): boolean {
  const { cfg, state } = h;
  const over = () => ctxBefore - frozenSavings(h, ix) > target;
  if (!over()) return false;
  let changed = false;
  const last = ix.nSteps - 1;
  for (const t of ix.thinks) {
    if (state.elided[t.key] || last - t.step < Math.max(0, cfg.emergencyKeepThinking)) continue;
    archiveThink(h, t);
    changed = true;
  }
  type Item = { step: number; tokens: number; key: string; go: () => void };
  const items: Item[] = [
    ...ix.results.filter((r) => !r.hasImage && r.tokens > RESULT_MIN_TOKENS_FLOOR).map((r) => ({ step: r.step, tokens: r.tokens, key: r.id, go: () => archiveResult(h, r) })),
    ...ix.args.map((a) => ({ step: a.step, tokens: a.tokens, key: a.key, go: () => archiveArg(h, a) })),
  ].filter((i) => i.step < last);
  const run = (pred: (i: Item) => boolean, order: (a: Item, b: Item) => number) => {
    for (const i of items.filter(pred).sort(order)) {
      if (!over()) break;
      if (state.elided[i.key]) continue;
      i.go();
      changed = true;
    }
  };
  run((i) => last - i.step >= cfg.emergencyKeepSteps, (a, b) => a.step - b.step || b.tokens - a.tokens);
  run(() => true, (a, b) => b.tokens - a.tokens);
  return changed;
}

function archiveResult(h: Host, r: ResultInfo): void {
  if (h.state.elided[r.id]) return;
  const text = resultText(h.messages[r.idx]);
  h.state.elided[r.id] = entryFor(h, r, h.spill(r.id, r.tool, r.step, text));
}

function archiveArg(h: Host, a: ArgInfo): void {
  if (h.state.elided[a.key]) return;
  const text = argText(h.messages, a);
  if (!text) return;
  h.state.elided[a.key] = entryForArg(a, h.spill(a.key, `${a.tool}.${a.name}`, a.step, text));
}

function archiveThink(h: Host, t: ThinkInfo): void {
  if (h.state.elided[t.key]) return;
  const text = thinkingText(h.messages[t.idx]);
  const path = h.spill(t.key, "thinking", t.step, text);
  h.state.elided[t.key] = { id: t.id, kind: "thinking", path, step: t.step, tool: "thinking", tokens: t.tokens };
}

function frozenSavings(h: Host, ix: Index): number {
  const { state } = h;
  let saved = 0;
  for (const r of ix.results) if (state.elided[r.id]) saved += resultSavings(h, r);
  for (const a of ix.args) if (state.elided[a.key]) saved += argSavings(h, a);
  for (const t of ix.thinks) if (state.elided[t.key]) saved += t.tokens;
  return saved;
}

function apply(h: Host, ix: Index, stats: Stats): Msg[] {
  const { messages, state, cfg } = h;
  const resultAt = new Map(ix.results.map((r) => [r.idx, r]));
  const thinkAt = new Map(ix.thinks.map((t) => [t.idx, t]));
  const argsAt = new Map<number, ArgInfo[]>();
  for (const a of ix.args) {
    if (!state.elided[a.key]) continue;
    argsAt.set(a.idx, [...(argsAt.get(a.idx) ?? []), a]);
  }
  return messages.map((m, idx) => {
    if (m.role === "assistant") return applyAssistant(m, thinkAt.get(idx), argsAt.get(idx) ?? [], h, stats);
    if (m.role !== "toolResult") return m;
    const r = resultAt.get(idx);
    const e = r && state.elided[r.id];
    if (!r || !e) return m;
    stats.resultsElided++;
    return { ...m, content: [{ type: "text", text: stubFor(r, resultText(m), e, cfg) }] };
  });
}

// Arguments are rewritten on the original block indices first; thinking is filtered after.
function applyAssistant(m: Msg, t: ThinkInfo | undefined, args: ArgInfo[], h: Host, stats: Stats): Msg {
  if (!Array.isArray(m.content)) return m;
  let content: Block[] = m.content;
  if (args.length) {
    content = content.map((b, bi) => {
      if (b.type !== "toolCall") return b;
      const mine = args.filter((a) => a.bi === bi);
      if (!mine.length) return b;
      const next: Record<string, unknown> = { ...(b.arguments ?? {}) };
      for (const a of mine) {
        const e = h.state.elided[a.key];
        const v = next[a.name];
        if (!e || typeof v !== "string") continue;
        next[a.name] = argStub(v, e, h.cfg);
        stats.argsElided++;
      }
      return { ...b, arguments: next };
    });
  }
  if (t && h.state.elided[t.key]) {
    const kept = content.filter((b) => b.type !== "thinking");
    stats.thinkingDropped += content.length - kept.length;
    content = kept;
  }
  return content === m.content ? m : { ...m, content };
}
