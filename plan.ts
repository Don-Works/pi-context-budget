// context-budget: pure planning logic. No Pi imports so it runs under plain node
// (node >= 23 type stripping) and the replay harness exercises exactly the code
// the extension ships.
//
// Lossless for anything the model might need again: originals are snapshotted to
// an addressable archive and the prompt keeps a citation (id + head/tail), a
// structural reduction, or a one-line index entry. User text and assistant text
// are never altered. Old tool results, large tool-call arguments and old thinking
// are archived; thinking is dropped from the prompt (it is billed on every
// resend), the other two leave something addressable behind.
//
// The plan only ever grows and advances in batches, so the serialized prefix
// sent to the provider stays byte-identical between advances (vLLM prefix cache).
// If the frozen view is still above targetFraction, an opt-in squeeze pass elides
// more (including recent/protected results) until we are at or below the cap.
import { estimate, type Config } from "./config.ts";
import { RESULT_MIN_TOKENS_FLOOR, argId, argStub, tierOf, type Elided, type Spill, type Tier } from "./archive.ts";
import { argText, estimateMessages, getAt, indexMessages, latestBySig, protectedReads, recalledIds, setAt, thinkingText, type ArgInfo, type Block, type Index, type Msg, type ResultInfo, type ThinkInfo } from "./messages.ts";
import { currentSavings, gainAt, isReducible, leanCandidates, placeAt, savingsAt, sentFor, targetTier, type Host } from "./tier.ts";
import { emptyScratch, type Scratch } from "./pin.ts";

export { DEFAULTS, estimate, mergeConfig, type Config } from "./config.ts";
export * from "./archive.ts";
export * from "./budget.ts";
export * from "./compact.ts";
export * from "./cut.ts";
export * from "./pin.ts";
export * from "./reduce.ts";
export * from "./summary.ts";
export * from "./tier.ts";
export { argPathName, estimateMessages, getAt, indexMessages, resultText, setAt, textOf, type Msg } from "./messages.ts";

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
  resultsReduced: number;
  resultsLean: number;
  argsElided: number;
  eligibleWaiting: number;
}

// baseTokens: prompt overhead the messages do not carry (system prompt, tool schemas).
export function plan(messages: Msg[], state: PlanState, cfg: Config, contextWindow: number, spill: Spill, baseTokens = 0): { messages: Msg[]; stats: Stats } {
  const ix = indexMessages(messages, cfg);
  const ctxBefore = baseTokens + estimateMessages(messages, cfg);
  const h: Host = { messages, state, cfg, spill, latest: latestBySig(ix.results), recalled: recalledIds(messages), stubTokens: new Map() };
  const ctxFrozen = ctxBefore - frozenSavings(h, ix);
  const stats: Stats = { ctxBefore, ctxAfter: ctxFrozen, advanced: false, squeezed: false, elidedTotal: 0, thinkingDropped: 0, resultsElided: 0, resultsReduced: 0, resultsLean: 0, argsElided: 0, eligibleWaiting: 0 };

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

function argSavings(h: Host, a: ArgInfo): number {
  let stub = h.stubTokens.get(a.key);
  if (stub == null) {
    const e = h.state.elided[a.key] ?? entryForArg(a, "pending");
    stub = estimate(argStub(argText(h.messages, a), e, h.cfg, a.filePath), h.cfg);
    h.stubTokens.set(a.key, stub);
  }
  return Math.max(0, a.tokens - stub);
}

function entryForArg(a: ArgInfo, path?: string): Elided {
  return { id: argId(a.callId, a.ordinal), kind: "arg", path, step: a.step, tool: `${a.tool}(${a.name})`, tokens: a.tokens };
}

interface Batch {
  reduce: { r: ResultInfo; tier: Tier }[];
  cite: ResultInfo[];
  lean: ResultInfo[];
  args: ArgInfo[];
  thinks: ThinkInfo[];
  tokens: number;
}

// A reduction is a projection of the result, not a summary of it, so unlike a citation it does
// not wait for keepRecentSteps: the model can still pick a tool from the reduced list.
function eligible(h: Host, ix: Index, last: number): Batch {
  const { cfg, state } = h;
  const oldEnough = (step: number) => last - step >= Math.max(1, cfg.keepRecentSteps);
  const protect = protectedReads(h.messages, ix.results, cfg);
  const open = (r: { id: string; hasImage: boolean }) => !state.elided[r.id] && !r.hasImage && !protect.has(r.id);
  // Age 1, not keepRecentSteps: the latest assistant step is still never touched (the model has
  // not read those results yet), but a reduction does not have to wait any longer than that.
  const reduce = ix.results
    .filter((r) => open(r) && last - r.step >= 1 && r.tokens > cfg.minResultTokens && isReducible(h, r))
    .map((r) => ({ r, tier: "reduced" as Tier }));
  const taken = new Set(reduce.map((x) => x.r.id));
  const cite = ix.results.filter((r) => open(r) && !taken.has(r.id) && oldEnough(r.step) && r.tokens > cfg.minResultTokens);
  const lean = leanCandidates(h, ix, last, { after: cfg.leanAfterSteps, includeErrors: false, protect });
  const args = ix.args.filter((a) => !state.elided[a.key] && oldEnough(a.step));
  const thinks = ix.thinks.filter((t) => !state.elided[t.key] && last - t.step >= cfg.keepThinkingSteps);
  const tokens =
    reduce.reduce((n, x) => n + savingsAt(h, x.r, x.tier), 0) +
    cite.reduce((n, r) => n + savingsAt(h, r, "cite"), 0) +
    lean.reduce((n, r) => n + gainAt(h, r, "lean"), 0) +
    args.reduce((n, a) => n + argSavings(h, a), 0);
  return { reduce, cite, lean, args, thinks, tokens };
}

function advance(h: Host, ix: Index, hot: boolean, stats: Stats): boolean {
  const { cfg } = h;
  const b = eligible(h, ix, ix.nSteps - 1);
  stats.eligibleWaiting = b.tokens;
  const any = b.reduce.length + b.cite.length + b.lean.length + b.args.length + b.thinks.length > 0;
  if (!(b.tokens >= cfg.batchTokens || b.thinks.length >= cfg.thinkBatchSteps || (hot && any))) return false;
  for (const x of b.reduce) placeAt(h, x.r, x.tier);
  for (const r of b.cite) placeAt(h, r, "cite");
  for (const r of b.lean) placeAt(h, r, "lean");
  for (const a of b.args) archiveArg(h, a);
  for (const t of b.thinks) archiveThink(h, t);
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
  // Cheapest move first: an old citation nobody has recalled becomes a one-line index entry.
  // That costs nothing the model has shown it wants, unlike eliding something recent.
  const protect = protectedReads(h.messages, ix.results, cfg);
  for (const r of leanCandidates(h, ix, last, { after: Math.max(1, cfg.emergencyKeepSteps), includeErrors: true, protect })) {
    if (!over()) break;
    placeAt(h, r, "lean");
    changed = true;
  }
  for (const t of ix.thinks) {
    if (state.elided[t.key] || last - t.step < Math.max(0, cfg.emergencyKeepThinking)) continue;
    archiveThink(h, t);
    changed = true;
  }
  type Item = { step: number; tokens: number; key: string; go: () => void };
  const items: Item[] = [
    ...ix.results.filter((r) => !r.hasImage && r.tokens > RESULT_MIN_TOKENS_FLOOR).map((r) => ({ step: r.step, tokens: r.tokens, key: r.id, go: () => placeAt(h, r, targetTier(h, r)) })),
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
  for (const r of ix.results) saved += currentSavings(h, r);
  for (const a of ix.args) if (state.elided[a.key]) saved += argSavings(h, a);
  for (const t of ix.thinks) if (state.elided[t.key]) saved += t.tokens;
  return saved;
}

function apply(h: Host, ix: Index, stats: Stats): Msg[] {
  const { messages, state } = h;
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
    const tier = tierOf(e) ?? "cite";
    stats.resultsElided++;
    if (tier === "reduced") stats.resultsReduced++;
    else if (tier === "lean") stats.resultsLean++;
    return { ...m, content: [{ type: "text", text: sentFor(h, r, tier, e) }] };
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
      let next: Record<string, unknown> = { ...(b.arguments ?? {}) };
      for (const a of mine) {
        const e = h.state.elided[a.key];
        const v = getAt(next, a.segs);
        if (!e || typeof v !== "string") continue;
        next = setAt(next, a.segs, argStub(v, e, h.cfg, a.filePath));
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
