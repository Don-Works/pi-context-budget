import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  PIN_PREFIX,
  archiveId,
  deterministicSummary,
  findElided,
  firstUserText,
  formatCatalog,
  formatPin,
  headTail,
  isPinMessage,
  newState,
  plan,
  seedScratch,
  setScratch,
  sliceArchive,
  stripPin,
  thinkId,
} from "./plan.ts";

const big = (tag) => Array.from({ length: 80 }, (_, i) => `${tag} line ${i} ${"x".repeat(40)}`).join("\n");
const spill = (id, tool, step) => `/spill/${step}-${tool}.txt`;

// One user turn followed by `steps` assistant steps, each thinking + text + one tool call + its result.
function session(steps, mkCall = (i) => ({ name: "bash", args: { command: `cmd${i}` }, text: big(`out${i}`), isError: false })) {
  const msgs = [{ role: "user", content: "do the thing" }];
  for (let i = 0; i < steps; i++) {
    const c = mkCall(i);
    msgs.push({ role: "assistant", content: [{ type: "thinking", thinking: `think ${i} ${"t".repeat(300)}` }, { type: "text", text: `note ${i}` }, { type: "toolCall", id: `call${i}`, name: c.name, arguments: c.args }] });
    msgs.push({ role: "toolResult", toolCallId: `call${i}`, toolName: c.name, isError: c.isError, content: [{ type: "text", text: c.text }] });
  }
  return msgs;
}
const resultText = (m) => m.content[0].text;
const thinkingOf = (m) => m.content.filter((b) => b.type === "thinking").length;

test("does nothing below startAtFraction of the window", () => {
  const msgs = session(12);
  const { messages, stats } = plan(msgs, newState(), DEFAULTS, 10_000_000, spill);
  assert.equal(stats.advanced, false);
  assert.deepEqual(messages, msgs);
});

test("advances: stubs old results, drops old thinking, keeps the model's own words", () => {
  const msgs = session(12);
  const state = newState();
  const { messages, stats } = plan(msgs, state, DEFAULTS, 40_000, spill);
  assert.equal(stats.advanced, true);
  assert.equal(state.gen, 1);
  const results = messages.filter((m) => m.role === "toolResult");
  // 12 steps, keepRecentSteps 8 => steps 0..3 are old enough
  assert.equal(results.filter((m) => resultText(m).includes("[context-budget]")).length, 4);
  assert.match(resultText(results[0]), /id=cb-call0/);
  assert.match(resultText(results[0]), /step 0/);
  assert.match(resultText(results[0]), /\/spill\/0-bash\.txt/);
  assert.match(resultText(results[0]), /context_budget_recall id=cb-call0/);
  assert.match(resultText(results[0]), /Head:/);
  assert.match(resultText(results[0]), /Tail:/);
  assert.match(resultText(results[0]), /out0 line 0/);
  assert.match(resultText(results[0]), /out0 line 79/);
  assert.equal(resultText(results[11]), big("out11"));
  const assistants = messages.filter((m) => m.role === "assistant");
  // keepThinkingSteps 6 => thinking survives only on the last 6 steps
  assert.deepEqual(assistants.map(thinkingOf), [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
  assistants.forEach((m, i) => assert.equal(m.content.find((b) => b.type === "text").text, `note ${i}`));
  assert.deepEqual(messages[0], msgs[0]);
  assert.ok(stats.ctxAfter < stats.ctxBefore * 0.8);
});

test("plan is frozen between advances so the prefix stays identical", () => {
  const msgs = session(12);
  const state = newState();
  const first = plan(msgs, state, DEFAULTS, 40_000, spill);
  assert.equal(first.stats.advanced, true);
  const more = session(13);
  const second = plan(more, state, DEFAULTS, 40_000, spill);
  assert.equal(second.stats.advanced, false, "one newly eligible result is below batchTokens");
  assert.equal(state.gen, 1);
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
});

test("latest un-superseded read is protected; an edit of the path releases it", () => {
  const mk = (i) => (i === 0 ? { name: "read", args: { path: "/p/a.go" }, text: big("file"), isError: false } : { name: "bash", args: { command: `c${i}` }, text: big(`o${i}`), isError: false });
  let msgs = session(12, mk);
  let out = plan(msgs, newState(), DEFAULTS, 40_000, spill);
  assert.equal(resultText(out.messages[2]), big("file"), "protected read kept verbatim");
  msgs = session(12, mk);
  msgs[3].content.push({ type: "toolCall", id: "editX", name: "edit", arguments: { path: "/p/a.go", edits: [] } });
  out = plan(msgs, newState(), DEFAULTS, 40_000, spill);
  const stub = resultText(out.messages[2]);
  assert.match(stub, /id=cb-call0/);
  assert.match(stub, /read \/p\/a\.go/);
  assert.match(stub, /re-read \/p\/a\.go only if you want the current disk contents/);
  assert.match(stub, /\/spill\/0-read\.txt/, "elided reads are snapshotted, not discarded");
});

test("error results keep head and tail", () => {
  const mk = (i) => ({ name: "bash", args: { command: `c${i}` }, text: big(`err${i}`), isError: i === 0 });
  const out = plan(session(12, mk), newState(), { ...DEFAULTS, stubHeadChars: 50, stubTailChars: 40 }, 40_000, spill);
  const t = resultText(out.messages[2]);
  assert.match(t, /error=true/);
  assert.ok(t.includes(big("err0").slice(0, 50)));
  assert.ok(t.includes(big("err0").slice(-40)));
  assert.match(t, /\[context-budget\] id=cb-call0/);
});

test("disabled config passes messages through untouched", () => {
  const msgs = session(12);
  const { messages, stats } = plan(msgs, newState(), { ...DEFAULTS, enabled: false }, 1_000, spill);
  assert.equal(stats.advanced, false);
  assert.deepEqual(messages, msgs);
});

test("thinking is archived under th-<step> when dropped", () => {
  const state = newState();
  const spilled = [];
  const capture = (id, tool, step, text) => {
    spilled.push({ id, tool, step, text });
    return `/spill/${step}-${tool}.txt`;
  };
  plan(session(12), state, DEFAULTS, 40_000, capture);
  assert.equal(state.thinkCut, 6);
  for (let i = 0; i < 6; i++) {
    const e = state.elided[`think:${i}`];
    assert.ok(e, `thinking step ${i} archived`);
    assert.equal(e.id, thinkId(i));
    assert.equal(e.tool, "thinking");
    assert.ok(e.path.endsWith(`/${i}-thinking.txt`));
  }
  assert.equal(spilled.filter((s) => s.tool === "thinking").length, 6);
  assert.match(spilled.find((s) => s.id === "think:0").text, /^think 0 /);
  assert.equal(formatCatalog(state).split("\n").filter((l) => l.startsWith("th-")).length, 6);
});

test("duplicate tool+args is marked on the older citation", () => {
  const mk = (i) => ({ name: "bash", args: { command: "ls -la" }, text: big(`dup${i}`), isError: false });
  const state = newState();
  const { messages } = plan(session(12, mk), state, DEFAULTS, 40_000, spill);
  const stub = resultText(messages[2]);
  assert.match(stub, /Exact duplicate of a later bash \(cb-call11/);
  assert.equal(state.elided.call0.duplicateOf, archiveId("call11"));
});

test("archive ids are stable and findable", () => {
  assert.equal(archiveId("call0"), "cb-call0");
  assert.equal(archiveId("tool-call-a1b2c3d4e5"), "cb-b2c3d4e5");
  const state = newState();
  plan(session(12), state, DEFAULTS, 40_000, spill);
  assert.equal(findElided(state, "cb-call0")?.tool, "bash");
  assert.equal(findElided(state, "call0")?.id, "cb-call0");
  assert.equal(findElided(state, "th-0")?.tool, "thinking");
  assert.equal(findElided(state, "missing"), undefined);
});

test("headTail and sliceArchive are exact and reconstructible", () => {
  const text = "H".repeat(20) + "M".repeat(50) + "T".repeat(20);
  const { head, tail, omitted } = headTail(text, 20, 20);
  assert.equal(head, "H".repeat(20));
  assert.equal(tail, "T".repeat(20));
  assert.equal(omitted, 50);
  assert.equal(head + "M".repeat(omitted) + tail, text);

  const a = sliceArchive(text, 0, 30);
  const b = sliceArchive(text, a.next, 30);
  const c = sliceArchive(text, b.next, 30);
  assert.equal(a.body + b.body + c.body, text);
  assert.equal(c.next, null);
  assert.equal(c.total, text.length);
});

test("squeeze keeps sent context at or below targetFraction", () => {
  const window = 20_000;
  const { messages, stats } = plan(session(12), newState(), { ...DEFAULTS, squeeze: true }, window, spill);
  assert.equal(stats.squeezed, true);
  assert.ok(stats.ctxAfter <= DEFAULTS.targetFraction * window, `${stats.ctxAfter} vs ${DEFAULTS.targetFraction * window}`);
  const results = messages.filter((m) => m.role === "toolResult");
  assert.ok(results.filter((m) => resultText(m).includes("[context-budget]")).length >= 4);
  assert.deepEqual(messages[0], session(12)[0]);
});

test("session pin seeds from the first user message and rejects oversized writes", () => {
  const state = newState();
  const msgs = session(3);
  assert.equal(seedScratch(state.scratch, msgs, DEFAULTS), true);
  assert.match(state.scratch.goal, /do the thing/);
  assert.equal(seedScratch(state.scratch, msgs, DEFAULTS), false, "does not overwrite");
  const pin = formatPin(state.scratch);
  assert.ok(pin.startsWith(PIN_PREFIX));
  assert.equal(isPinMessage({ role: "user", content: pin }), true);
  assert.equal(stripPin([...msgs, { role: "user", content: pin }]).length, msgs.length);
  assert.equal(firstUserText([{ role: "user", content: pin }, ...msgs]), "do the thing");
  const tooBig = setScratch(state.scratch, { notes: "n".repeat(DEFAULTS.scratchLimitChars) }, DEFAULTS);
  assert.equal(tooBig.ok, false);
  assert.equal(state.scratch.notes, "");
});

test("deterministicSummary is an index, not an LLM paraphrase, and stays bounded", () => {
  const state = newState();
  plan(session(12), state, DEFAULTS, 40_000, spill);
  state.scratch.goal = "ship lossless pin";
  state.scratch.notes = "- no LLM summary";
  const text = deterministicSummary({
    messagesToSummarize: session(4),
    previousSummary: "old summary " + "x".repeat(200),
    fileOps: { read: ["a.ts"], edited: ["b.ts"] },
    tokensBefore: 90000,
    customInstructions: "keep the goal",
  }, state, DEFAULTS);
  assert.match(text, /## Goal\nship lossless pin/);
  assert.match(text, /no LLM summary/);
  assert.match(text, /context_budget_recall/);
  assert.match(text, /<read-files>\na\.ts/);
  assert.match(text, /<modified-files>\nb\.ts/);
  assert.match(text, /cb-call0/);
  assert.ok(text.length < 8000);
});
