import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, newState, plan } from "./plan.ts";

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
  const { messages, stats } = plan(msgs, state, DEFAULTS, 20_000, spill);
  assert.equal(stats.advanced, true);
  assert.equal(state.gen, 1);
  const results = messages.filter((m) => m.role === "toolResult");
  // 12 steps, keepRecentSteps 8 => steps 0..3 are old enough
  assert.equal(results.filter((m) => resultText(m).includes("[context-budget]")).length, 4);
  assert.match(resultText(results[0]), /Elided bash output from step 0 \(\d+ tokens, 80 lines\)\. Began: "out0 line 0/);
  assert.match(resultText(results[0]), /\/spill\/0-bash\.txt/);
  assert.equal(resultText(results[11]), big("out11"));
  const assistants = messages.filter((m) => m.role === "assistant");
  // keepThinkingSteps 6 => thinking survives only on the last 6 steps
  assert.deepEqual(assistants.map(thinkingOf), [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1]);
  assistants.forEach((m, i) => assert.equal(m.content.find((b) => b.type === "text").text, `note ${i}`));
  assert.deepEqual(messages[0], msgs[0]);
  assert.ok(stats.ctxAfter < stats.ctxBefore * 0.7);
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
  let out = plan(msgs, newState(), DEFAULTS, 20_000, spill);
  assert.equal(resultText(out.messages[2]), big("file"), "protected read kept verbatim");
  msgs = session(12, mk);
  msgs[3].content.push({ type: "toolCall", id: "editX", name: "edit", arguments: { path: "/p/a.go", edits: [] } });
  out = plan(msgs, newState(), DEFAULTS, 20_000, spill);
  assert.match(resultText(out.messages[2]), /Elided read of \/p\/a\.go from step 0 .* Re-read the file/);
});

test("error results keep their head", () => {
  const mk = (i) => ({ name: "bash", args: { command: `c${i}` }, text: big(`err${i}`), isError: i === 0 });
  const out = plan(session(12, mk), newState(), { ...DEFAULTS, errorHeadChars: 50 }, 20_000, spill);
  const t = resultText(out.messages[2]);
  assert.ok(t.startsWith(big("err0").slice(0, 50)));
  assert.match(t, /\[context-budget\] Elided bash output/);
});

test("disabled config passes messages through untouched", () => {
  const msgs = session(12);
  const { messages, stats } = plan(msgs, newState(), { ...DEFAULTS, enabled: false }, 1_000, spill);
  assert.equal(stats.advanced, false);
  assert.deepEqual(messages, msgs);
});
