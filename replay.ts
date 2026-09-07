// Replay a recorded Pi session through plan.ts request by request.
// usage: node replay.ts <session.jsonl> [contextWindow]
import { readFileSync } from "node:fs";
import { DEFAULTS, newState, plan } from "./plan.ts";

const file = process.argv[2];
const window = Number(process.argv[3] ?? 131072);
const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const byId = new Map(rows.filter((r) => r.id).map((r) => [r.id, r]));
let cur = rows.filter((r) => r.id).at(-1);
const path: any[] = [];
while (cur) { path.push(cur); cur = byId.get(cur.parentId); }
path.reverse();
const msgs = path.filter((e) => e.type === "message").map((e) => e.message);

const state = newState();
let sumBefore = 0, sumAfter = 0, advances = 0, peakBefore = 0, peakAfter = 0, requests = 0;
const spilled = new Set<string>();
const spill = (key: string, tool: string, step: number) => { spilled.add(key); return `/spill/${step}-${tool}.txt`; };
for (let i = 0; i < msgs.length; i++) {
  if (msgs[i].role !== "assistant") continue;
  requests++;
  const { stats } = plan(msgs.slice(0, i), state, DEFAULTS, window, spill);
  sumBefore += stats.ctxBefore; sumAfter += stats.ctxAfter;
  peakBefore = Math.max(peakBefore, stats.ctxBefore); peakAfter = Math.max(peakAfter, stats.ctxAfter);
  if (stats.advanced) advances++;
}
const last = plan(msgs, state, DEFAULTS, window, spill);
console.log(JSON.stringify({
  file: file.split("/").at(-1)?.slice(0, 19), requests, advances,
  peak_ctx_est: { before: peakBefore, after: peakAfter },
  cumulative_prompt_tokens_k: { before: Math.round(sumBefore / 1000), after: Math.round(sumAfter / 1000) },
  final: { ctxBefore: last.stats.ctxBefore, ctxAfter: last.stats.ctxAfter, resultsElided: last.stats.resultsElided, argsElided: last.stats.argsElided, thinkingDropped: last.stats.thinkingDropped, spilled: spilled.size },
}, null, 1));
// show two example stubs
const stubs = last.messages.filter((m: any) => m.role === "toolResult" && typeof m.content?.[0]?.text === "string" && m.content[0].text.includes("[context-budget]")).slice(0, 2);
for (const s of stubs) console.log("STUB:", (s as any).content[0].text.slice(0, 300));
