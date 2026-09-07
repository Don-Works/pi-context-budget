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
  mergeConfig,
  newState,
  plan,
  seedScratch,
  setScratch,
  sliceArchive,
  stripPin,
  textOf,
} from "./plan.ts";

const big = (tag) => Array.from({ length: 80 }, (_, i) => `${tag} line ${i} ${"x".repeat(40)}`).join("\n");
const spill = (id, tool, step) => `/spill/${step}-${tool}.txt`;

// One user turn followed by `steps` assistant steps, each thinking + text + one tool call + its result.
function session(steps, mkCall = (i) => ({ name: "bash", args: { command: `cmd${i}` }, text: big(`out${i}`), isError: false })) {
  const msgs = [{ role: "user", content: "do the thing" }];
  for (let i = 0; i < steps; i++) {
    const c = mkCall(i);
    msgs.push({ role: "assistant", content: [{ type: "thinking", thinking: `think ${i} ${"t".repeat(300)}` }, { type: "text", text: `note ${i}` }, { type: "toolCall", id: `call${i}`, name: c.name, arguments: c.args }] });
    msgs.push({ role: "toolResult", toolCallId: `call${i}`, toolName: c.name, isError: c.isError, content: c.content ?? [{ type: "text", text: c.text }] });
  }
  return msgs;
}
const resultText = (m) => m.content[0].text;
const thinkingOf = (m) => m.content.filter((b) => b.type === "thinking").length;
const kinds = (state) => Object.values(state.elided).reduce((n, e) => ({ ...n, [e.kind]: (n[e.kind] ?? 0) + 1 }), {});

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
  assert.equal(stats.resultsElided, 4);
  assert.match(resultText(results[0]), /id=cb-call0/);
  assert.match(resultText(results[0]), /step 0/);
  assert.match(resultText(results[0]), /context_budget_recall id=cb-call0/);
  assert.match(resultText(results[0]), /Head:/);
  assert.match(resultText(results[0]), /Tail:/);
  assert.match(resultText(results[0]), /out0 line 0/);
  assert.match(resultText(results[0]), /out0 line 79/);
  assert.ok(resultText(results[0]).length < big("out0").length / 2, "a citation is well under half the original");
  assert.equal(state.elided.call0.path, "/spill/0-bash.txt");
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

test("thinking keys are content-based, so a compaction that shifts step numbers loses nothing", () => {
  const state = newState();
  const spilled = new Map();
  const capture = (key, tool, step, text) => { spilled.set(key, { tool, step, text }); return `/spill/${step}-${tool}.txt`; };
  plan(session(12), state, DEFAULTS, 40_000, capture);
  assert.equal(kinds(state).thinking, 6);
  for (const e of Object.values(state.elided).filter((e) => e.kind === "thinking")) {
    assert.match(e.id, /^th-[0-9a-f]{12}$/);
    assert.equal(e.tool, "thinking");
  }
  const think0 = Object.entries(state.elided).find(([, e]) => e.kind === "thinking" && e.step === 0);
  assert.match(spilled.get(think0[0]).text, /^think 0 /);
  assert.equal(findElided(state.elided, think0[1].id).step, 0);
  // Pi compacts away the first four steps: what was step 4 is now step 0.
  const compacted = [{ role: "compactionSummary", summary: "index" }, ...session(12).slice(1 + 2 * 4)];
  const { messages, stats } = plan(compacted, state, DEFAULTS, 40_000, capture);
  assert.equal(stats.advanced, false);
  const assistants = messages.filter((m) => m.role === "assistant");
  // old steps 4,5 were archived and stay dropped; old steps 6..11 were never archived and must survive
  assert.deepEqual(assistants.map(thinkingOf), [0, 0, 1, 1, 1, 1, 1, 1]);
  assert.equal(kinds(state).thinking, 6, "nothing was silently dropped without an archive entry");
});

test("large tool-call arguments are archived under ca- ids and recallable", () => {
  const mk = (i) => ({ name: "write", args: { path: `/p/${i}.ts`, content: big(`file${i}`) }, text: `wrote /p/${i}.ts`, isError: false });
  const state = newState();
  const spilled = new Map();
  const capture = (key, tool, step, text) => { spilled.set(key, { tool, step, text }); return `/spill/${step}-${tool}.txt`; };
  const { messages, stats } = plan(session(12, mk), state, DEFAULTS, 40_000, capture);
  assert.equal(stats.advanced, true);
  assert.equal(stats.argsElided, 4, "steps 0..3 are older than keepRecentSteps");
  assert.equal(stats.resultsElided, 0, "small results stay");
  const call = (m) => m.content.find((b) => b.type === "toolCall");
  const assistants = messages.filter((m) => m.role === "assistant");
  const a0 = call(assistants[0]).arguments;
  assert.equal(a0.path, "/p/0.ts", "short arguments untouched");
  assert.match(a0.content, /^\[context-budget\] id=ca-call0 {2}\d+ chars archived\. Head: file0 line 0/);
  assert.match(a0.content, /context_budget_recall id=ca-call0/);
  assert.ok(a0.content.length < 300);
  assert.equal(call(assistants[11]).arguments.content, big("file11"));
  const e = state.elided["arg:call0:content"];
  assert.equal(e.kind, "arg");
  assert.equal(e.tool, "write(content)");
  assert.equal(findElided(state.elided, "ca-call0"), e);
  assert.equal(spilled.get("arg:call0:content").text, big("file0"));
  assert.equal(spilled.get("arg:call0:content").tool, "write.content");
  // the original session messages were not mutated
  assert.equal(call(session(12, mk)[1]).arguments.content, big("file0"));
  assert.equal(plan(session(12, mk), newState(), { ...DEFAULTS, argMinTokens: 0 }, 40_000, spill).stats.argsElided, 0, "argMinTokens 0 disables");
});

test("latest un-superseded read is protected; an edit of the path releases it", () => {
  const mk = (i) => (i === 0 ? { name: "read", args: { path: "/p/a.go" }, text: big("file"), isError: false } : { name: "bash", args: { command: `c${i}` }, text: big(`o${i}`), isError: false });
  let msgs = session(12, mk);
  let out = plan(msgs, newState(), DEFAULTS, 40_000, spill);
  assert.equal(resultText(out.messages[2]), big("file"), "protected read kept verbatim");
  msgs = session(12, mk);
  msgs[3].content.push({ type: "toolCall", id: "editX", name: "edit", arguments: { path: "/p/a.go", edits: [] } });
  const state = newState();
  out = plan(msgs, state, DEFAULTS, 40_000, spill);
  const stub = resultText(out.messages[2]);
  assert.match(stub, /id=cb-call0/);
  assert.match(stub, /read \/p\/a\.go/);
  assert.match(stub, /re-read \/p\/a\.go for current contents/);
  assert.equal(state.elided.call0.path, "/spill/0-read.txt", "elided reads are snapshotted, not discarded");
});

test("error results keep head and the configured tail", () => {
  const mk = (i) => ({ name: "bash", args: { command: `c${i}` }, text: big(`err${i}`), isError: i === 0 });
  const out = plan(session(12, mk), newState(), { ...DEFAULTS, stubHeadChars: 50, stubTailChars: 40 }, 40_000, spill);
  const t = resultText(out.messages[2]);
  assert.match(t, /lines {2}error/);
  assert.ok(t.includes(big("err0").slice(0, 50)));
  assert.ok(t.includes(big("err0").slice(-40)));
  assert.match(t, /\[context-budget\] id=cb-call0/);
});

test("the latest step is never elided, even with keepRecentSteps 0 or under squeeze", () => {
  let out = plan(session(12), newState(), { ...DEFAULTS, keepRecentSteps: 0 }, 40_000, spill);
  assert.equal(resultText(out.messages.at(-1)), big("out11"));
  const window = 20_000;
  out = plan(session(12), newState(), { ...DEFAULTS, squeeze: true }, window, spill);
  assert.equal(out.stats.squeezed, true);
  assert.ok(out.stats.ctxAfter <= DEFAULTS.targetFraction * window, `${out.stats.ctxAfter} vs ${DEFAULTS.targetFraction * window}`);
  assert.equal(resultText(out.messages.at(-1)), big("out11"), "the result the model has not seen yet is intact");
  assert.ok(out.messages.filter((m) => m.role === "toolResult" && resultText(m).includes("[context-budget]")).length >= 4);
  assert.deepEqual(out.messages[0], session(12)[0]);
});

test("results carrying images are never elided", () => {
  const mk = (i) => (i === 0
    ? { name: "read", args: { path: "/p/shot.png" }, content: [{ type: "text", text: big("img") }, { type: "image", data: "…", mimeType: "image/png" }] }
    : { name: "bash", args: { command: `c${i}` }, text: big(`o${i}`), isError: false });
  const msgs = session(12, mk);
  msgs[3].content.push({ type: "toolCall", id: "editX", name: "write", arguments: { path: "/p/shot.png", content: "x" } });
  const { messages, stats } = plan(msgs, newState(), DEFAULTS, 40_000, spill);
  assert.deepEqual(messages[2], msgs[2]);
  assert.equal(stats.resultsElided, 3);
});

test("disabled config passes messages through untouched", () => {
  const msgs = session(12);
  const { messages, stats } = plan(msgs, newState(), { ...DEFAULTS, enabled: false }, 1_000, spill);
  assert.equal(stats.advanced, false);
  assert.deepEqual(messages, msgs);
});

test("a repeated call is marked on the older citation without claiming identical output", () => {
  const mk = (i) => ({ name: "bash", args: { command: "ls -la" }, text: big(`dup${i}`), isError: false });
  const state = newState();
  const { messages } = plan(session(12, mk), state, DEFAULTS, 40_000, spill);
  const stub = resultText(messages[2]);
  assert.match(stub, /Same call as later cb-call11; output may differ/);
  assert.equal(state.elided.call0.duplicateOf, archiveId("call11"));
  assert.match(formatCatalog(state.elided), /cb-call0\tbash\tstep 0\t\d+ tok same-call-as=cb-call11 \/spill\/0-bash\.txt/);
});

test("archive ids are stable and findable", () => {
  assert.equal(archiveId("call0"), "cb-call0");
  assert.equal(archiveId("tool-call-a1b2c3d4e5"), "cb-b2c3d4e5");
  const state = newState();
  plan(session(12), state, DEFAULTS, 40_000, spill);
  assert.equal(findElided(state.elided, "cb-call0")?.tool, "bash");
  assert.equal(findElided(state.elided, "call0")?.id, "cb-call0");
  assert.equal(findElided(state.elided, "missing"), undefined);
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

test("estimates count summaries, shell output and the caller's base tokens", () => {
  assert.equal(textOf({ role: "compactionSummary", summary: "s".repeat(33) }).length, 33);
  assert.equal(textOf({ role: "bashExecution", command: "ls", output: "o".repeat(66) }).length, 66);
  const a = plan(session(2), newState(), DEFAULTS, 1_000_000, spill).stats.ctxBefore;
  const b = plan(session(2), newState(), DEFAULTS, 1_000_000, spill, 5000).stats.ctxBefore;
  assert.equal(b - a, 5000);
});

test("mergeConfig keeps defaults for unknown or mistyped keys and reads the old errorHeadChars", () => {
  const cfg = mergeConfig({ keepRecentSteps: "8", errorHeadChars: 123, bogus: 1, squeeze: true, charsPerToken: 0 });
  assert.equal(cfg.keepRecentSteps, DEFAULTS.keepRecentSteps);
  assert.equal(cfg.stubHeadChars, 123);
  assert.equal(cfg.squeeze, true);
  assert.equal(cfg.charsPerToken, DEFAULTS.charsPerToken);
  assert.equal("bogus" in cfg, false);
  assert.equal(mergeConfig({ keepRecentSteps: 0 }).keepRecentSteps, 1);
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
    fileOps: { read: new Set(["a.ts"]), edited: new Set(["b.ts"]), written: new Set() },
    tokensBefore: 90000,
    customInstructions: "keep the goal",
  }, state, DEFAULTS);
  assert.match(text, /## Goal\nship lossless pin/);
  assert.match(text, /no LLM summary/);
  assert.match(text, /context_budget_recall/);
  assert.match(text, /<read-files>\na\.ts/);
  assert.match(text, /<modified-files>\nb\.ts/);
  assert.match(text, /cb-call0/);
  assert.match(text, /4 tool snapshots, 6 thinking snapshots/);
  assert.ok(text.length < 8000);
});
