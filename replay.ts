// Replay a recorded Pi session through plan.ts request by request, under the same budget the
// extension would resolve for that window and Pi reserve.
// usage: node replay.ts <session.jsonl> [contextWindow] [reserveTokens] [baseTokens]
import { readFileSync } from "node:fs";
import { DEFAULTS, PI_COMPACTION_DEFAULTS, budgetFor, newState, plan } from "./plan.ts";

const file = process.argv[2];
const window = Number(process.argv[3] ?? 131072);
const reserveTokens = Number(process.argv[4] ?? PI_COMPACTION_DEFAULTS.reserveTokens);
const base = Number(process.argv[5] ?? 0); // system prompt + tool schemas, which the prompt also carries
// CONTEXT_BUDGET_REPLAY_CFG overrides any config key, so one recorded session can be replayed
// under two settings and the difference read off directly.
const overrides = process.env.CONTEXT_BUDGET_REPLAY_CFG ? JSON.parse(process.env.CONTEXT_BUDGET_REPLAY_CFG) : {};
const budget = budgetFor({ ...DEFAULTS, ...overrides }, window, { ...PI_COMPACTION_DEFAULTS, reserveTokens });
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
  const { stats } = plan(msgs.slice(0, i), state, budget.cfg, window, spill, base);
  sumBefore += stats.ctxBefore; sumAfter += stats.ctxAfter;
  peakBefore = Math.max(peakBefore, stats.ctxBefore); peakAfter = Math.max(peakAfter, stats.ctxAfter);
  if (stats.advanced) advances++;
}
const last = plan(msgs, state, budget.cfg, window, spill, base);
console.log(JSON.stringify({
  file: file.split("/").at(-1)?.slice(0, 19), requests, advances,
  budget: { cap: Math.round(budget.cap), pi_compacts_above: budget.trigger, clamped: budget.clamped },
  peak_ctx_est: { before: peakBefore, after: peakAfter },
  cumulative_prompt_tokens_k: { before: Math.round(sumBefore / 1000), after: Math.round(sumAfter / 1000) },
  final: { ctxBefore: last.stats.ctxBefore, ctxAfter: last.stats.ctxAfter, resultsElided: last.stats.resultsElided, resultsReduced: last.stats.resultsReduced, resultsLean: last.stats.resultsLean, argsElided: last.stats.argsElided, thinkingDropped: last.stats.thinkingDropped, spilled: spilled.size },
}, null, 1));
// show two example stubs
const stubs = last.messages.filter((m: any) => m.role === "toolResult" && typeof m.content?.[0]?.text === "string" && m.content[0].text.includes("[context-budget]")).slice(0, 2);
for (const s of stubs) console.log("STUB:", (s as any).content[0].text.slice(0, 300));
