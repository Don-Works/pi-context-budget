// context-budget — keeps a long Pi session inside the window the model works best in,
// without paraphrasing anything: old thinking blocks are dropped and stale tool
// outputs become stubs pointing at a spill file. Pure logic lives in ./plan.ts.
//
// Config: ~/.pi/agent/context-budget.json (any subset of DEFAULTS), or the file named
// by CONTEXT_BUDGET_CONFIG. Per-request stats go to CONTEXT_BUDGET_LOG when set.
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULTS, newState, plan, type Config, type PlanState, type Stats } from "./plan.ts";

const SPILL_ROOT = join(homedir(), ".pi", "agent", "context-budget");
const NOTE =
  "\n\n## Context budget\nOlder tool outputs may appear as \"[context-budget] Elided …\" stubs. Your own messages and " +
  "the user's messages are never altered. If you need an elided output again, read the saved file the stub names " +
  "or re-run the tool; otherwise continue from your own notes and conclusions.";

function loadConfig(): Config {
  const path = process.env.CONTEXT_BUDGET_CONFIG ?? join(homedir(), ".pi", "agent", "context-budget.json");
  try {
    if (existsSync(path)) return { ...DEFAULTS, ...JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    console.error(`context-budget: ignoring ${path}: ${err instanceof Error ? err.message : err}`);
  }
  return { ...DEFAULTS };
}

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  const states = new Map<string, PlanState>();
  let last: Stats | undefined;

  const stateFor = (sessionId: string) => {
    let s = states.get(sessionId);
    if (!s) states.set(sessionId, (s = newState()));
    return s;
  };

  const spillFor = (sessionId: string) => (id: string, tool: string, step: number, text: string) => {
    try {
      const dir = join(SPILL_ROOT, sessionId);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${String(step).padStart(3, "0")}-${tool}-${id.slice(-6).replace(/[^A-Za-z0-9]/g, "")}.txt`);
      if (!existsSync(path)) writeFileSync(path, text);
      return path;
    } catch {
      return undefined;
    }
  };

  pi.on("context", (event, ctx) => {
    if (!cfg.enabled) return;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const window = ctx.model?.contextWindow ?? 131072;
      const { messages, stats } = plan(event.messages as never[], stateFor(sessionId), cfg, window, spillFor(sessionId));
      last = stats;
      const state = stateFor(sessionId);
      if (process.env.CONTEXT_BUDGET_LOG) {
        const elided = Object.values(state.elided).map((e) => `${e.step}:${e.tool}:${e.tokens}${e.path ? ":spilled" : ""}`);
        appendFileSync(process.env.CONTEXT_BUDGET_LOG, JSON.stringify({ t: new Date().toISOString(), window, gen: state.gen, ...stats, elided }) + "\n");
      }
      if (ctx.hasUI) ctx.ui.setStatus("ctx-budget", stats.elidedTotal > 0 ? `ctx −${Math.round(stats.elidedTotal / 1000)}k g${state.gen}` : undefined);
      return { messages: messages as never[] };
    } catch (err) {
      console.error(`context-budget: falling back to full context: ${err instanceof Error ? err.message : err}`);
      return;
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!cfg.enabled) return;
    return { systemPrompt: event.systemPrompt + NOTE };
  });

  pi.registerCommand("ctx", {
    description: "context-budget: show what is being elided and why",
    handler: async (_args, ctx) => {
      const state = stateFor(ctx.sessionManager.getSessionId());
      const usage = ctx.getContextUsage();
      const lines = [
        `context window ${usage?.contextWindow ?? "?"} · provider-reported ${usage?.tokens ?? "?"} tokens (${usage?.percent?.toFixed(0) ?? "?"}%)`,
        last ? `last request: ${last.ctxBefore} est → ${last.ctxAfter} sent · ${last.resultsElided} results stubbed · ${last.thinkingDropped} thinking blocks dropped · ${last.eligibleWaiting} tokens waiting for next batch` : "no request yet",
        `plan generation ${state.gen} (each advance re-prefills the prefix once) · thinking kept for last ${cfg.keepThinkingSteps} steps · results kept for last ${cfg.keepRecentSteps} steps`,
        `spill dir ${join(SPILL_ROOT, ctx.sessionManager.getSessionId())}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
