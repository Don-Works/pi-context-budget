import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  PI_COMPACTION_DEFAULTS,
  boundaryStart,
  budgetFor,
  compactionTrigger,
  decideCompaction,
  deterministicSummary,
  isCutPoint,
  newState,
  piCompactionFrom,
  recut,
  spanFor,
  spanMessages,
  tokensToFree,
} from "./plan.ts";

const SMALL = 32_768;   // qwen3.5-4b-mlx
const BIG = 262_144;    // the local qwen3.8 lane
const pi = (over = {}) => ({ enabled: true, reserveTokens: 16384, keepRecentTokens: 32000, ...over });

const chars = (n) => "x".repeat(n);
let seq = 0;
const msg = (role, n, extra = {}) => ({ type: "message", id: `e${seq++}`, message: { role, content: [{ type: "text", text: chars(n) }], ...extra } });

// A branch of `steps` assistant/tool-result pairs after one user message: ~1200 tokens a step at the
// default 3.3 chars per token, the shape the 4b session was looping on.
function branch(steps) {
  seq = 0;
  const entries = [msg("user", 200)];
  for (let i = 0; i < steps; i++) {
    entries.push(msg("assistant", 660));
    entries.push({ ...msg("toolResult", 3300), message: { role: "toolResult", toolCallId: `call${i}`, content: [{ type: "text", text: chars(3300) }] } });
  }
  return entries;
}

test("a window with room for the configured target is left exactly as configured", () => {
  const b = budgetFor(DEFAULTS, BIG, pi());
  assert.equal(b.clamped, false);
  assert.equal(b.cfg, DEFAULTS); // same object: nothing about a big window is rewritten
  assert.equal(b.trigger, BIG - 16384);
  assert.equal(b.cap, 0.6 * BIG);
});

test("a small window is clamped under Pi's threshold, and squeeze is forced on to enforce it", () => {
  const b = budgetFor(DEFAULTS, SMALL, pi());
  assert.equal(b.trigger, 16384); // Pi compacts at half of a 32k window with the default reserve
  assert.equal(b.clamped, true);
  assert.ok(b.cap < b.trigger, `cap ${b.cap} must sit under the threshold ${b.trigger}`);
  assert.equal(b.cfg.squeeze, true);
  assert.ok(b.cfg.targetFraction < DEFAULTS.targetFraction);
  assert.ok(b.cfg.highWaterFraction <= b.cfg.targetFraction);
  assert.ok(b.cfg.startAtFraction <= b.cfg.targetFraction);
  assert.equal(DEFAULTS.squeeze, false); // the caller's config is never mutated
});

test("more reserve headroom is all the 32k lane needs; the clamp then does nothing", () => {
  const b = budgetFor(DEFAULTS, SMALL, pi({ reserveTokens: 8192, keepRecentTokens: 16000 }));
  assert.equal(b.trigger, 24_576);
  assert.equal(b.clamped, false);
  assert.equal(b.cfg, DEFAULTS);
  assert.ok(0.6 * SMALL < b.trigger);
});

test("with Pi's compaction off there is no threshold to stay under", () => {
  const b = budgetFor(DEFAULTS, SMALL, pi({ enabled: false }));
  assert.equal(b.trigger, Number.POSITIVE_INFINITY);
  assert.equal(b.clamped, false);
  assert.equal(tokensToFree(99_999, b.trigger), 0);
});

test("Pi's compaction settings are read with Pi's own fallbacks", () => {
  assert.deepEqual(piCompactionFrom({}), PI_COMPACTION_DEFAULTS);
  assert.deepEqual(piCompactionFrom({ compaction: { reserveTokens: "big", keepRecentTokens: 0 } }), PI_COMPACTION_DEFAULTS);
  assert.deepEqual(piCompactionFrom({ compaction: { enabled: false, reserveTokens: 8192, keepRecentTokens: 16000 } }), {
    enabled: false,
    reserveTokens: 8192,
    keepRecentTokens: 16000,
  });
  assert.equal(compactionTrigger(pi(), SMALL), 16384);
});

test("a recut never lands on a tool result and always keeps less than Pi's cut", () => {
  const entries = branch(20);
  const cut = recut(entries, 3, 6000, DEFAULTS);
  assert.ok(cut, "a 41-entry branch has a later cut point");
  assert.ok(cut.index > 3);
  assert.equal(isCutPoint(entries[cut.index]), true);
  assert.notEqual(entries[cut.index].message.role, "toolResult");
  assert.equal(recut(entries, entries.length - 1, 6000, DEFAULTS), undefined);
});

test("the compactable span starts after what the last compaction kept", () => {
  const entries = branch(4);
  assert.equal(boundaryStart(entries), 0);
  const compacted = [...entries.slice(0, 3), { type: "compaction", id: "c1", firstKeptEntryId: entries[3].id }, ...entries.slice(3)];
  assert.equal(boundaryStart(compacted), 4);
  assert.equal(spanMessages(compacted, 4, 6).length, 2);
});

// The loop observed on 2026-09-08: a 32768-token model with reserveTokens 16384 and
// keepRecentTokens 32000. Pi compacts above 16384, its cut keeps more tokens than the window holds,
// so each compaction dropped the first few entries and the next request compacted again.
test("Pi's cut frees far less than the threshold needs; the recut frees enough", () => {
  const entries = branch(20);
  const budget = budgetFor(DEFAULTS, SMALL, pi());
  const prep = {
    firstKeptEntryId: entries[3].id,
    messagesToSummarize: spanMessages(entries, 0, 3),
    turnPrefixMessages: [],
    tokensBefore: 24_288,
  };
  const own = spanFor(prep, [], budget, tokensToFree(24_288, budget.trigger), DEFAULTS);
  assert.equal(own.recut, false);
  assert.ok(own.tokens < 7904, "Pi's own cut frees under 2k of the ~7.9k needed");

  const d = decideCompaction({ prep, entries, budget, reason: "threshold", state: newState(), cfg: DEFAULTS });
  assert.equal(d.need, 24_288 - 16_384);
  assert.equal(d.recut, true);
  assert.equal(d.cancel, false);
  assert.ok(d.freed >= d.need, `recut frees ${d.freed}, needs ${d.need}`);
  const kept = entries.findIndex((e) => e.id === d.firstKeptEntryId);
  assert.ok(kept > 3);
  assert.notEqual(entries[kept].message.role, "toolResult");
});

test("a threshold compaction that cannot get under the threshold is cancelled, not repeated", () => {
  const budget = budgetFor(DEFAULTS, SMALL, pi());
  const prep = { firstKeptEntryId: "e3", messagesToSummarize: spanMessages(branch(20), 0, 3), turnPrefixMessages: [], tokensBefore: 24_288 };
  const args = { prep, entries: [], budget, state: newState(), cfg: DEFAULTS };
  assert.equal(decideCompaction({ ...args, reason: "threshold" }).cancel, true);
  // Overflow is the turn that already failed for size; cancelling it would only fail it again.
  assert.equal(decideCompaction({ ...args, reason: "overflow" }).cancel, false);
  assert.equal(decideCompaction({ ...args, reason: "manual" }).cancel, false);
});

test("a compaction that does get under the threshold keeps Pi's own cut", () => {
  const entries = branch(20);
  const budget = budgetFor(DEFAULTS, BIG, pi());
  const prep = {
    firstKeptEntryId: entries[30].id,
    messagesToSummarize: spanMessages(entries, 0, 30),
    turnPrefixMessages: [],
    tokensBefore: BIG - 10_000,
  };
  const d = decideCompaction({ prep, entries, budget, reason: "threshold", state: newState(), cfg: DEFAULTS });
  assert.equal(d.recut, false);
  assert.equal(d.cancel, false);
  assert.equal(d.firstKeptEntryId, entries[30].id);
});

test("the session goal survives later compactions through the previous summary", () => {
  const state = newState();
  const first = deterministicSummary({ messagesToSummarize: [{ role: "user", content: "check my calendar for Wednesday" }] }, state, DEFAULTS);
  assert.match(first, /^## Goal\ncheck my calendar for Wednesday$/m);
  const second = deterministicSummary({ messagesToSummarize: [], previousSummary: first }, state, DEFAULTS);
  assert.match(second, /^## Goal\ncheck my calendar for Wednesday$/m);
  assert.doesNotMatch(second.split("## Constraints")[0], /not captured/);
});
