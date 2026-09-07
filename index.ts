// context-budget — keeps a long Pi session inside the window the model works best in,
// without paraphrasing anything: old thinking is archived and dropped from the prompt,
// stale tool outputs and large tool-call arguments become addressable citations
// pointing at a spill snapshot. Pure logic lives in ./plan.ts and its modules.
//
// Config: ~/.pi/agent/context-budget.json (any subset of DEFAULTS), or the file named
// by CONTEXT_BUDGET_CONFIG. Per-request stats go to CONTEXT_BUDGET_LOG when set.
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimate } from "./config.ts";
import { formatPin, seedScratch, stripPin } from "./pin.ts";
import { plan, type PlanState, type Stats } from "./plan.ts";
import { loadConfig, loadState, saveState, spillFor } from "./store.ts";
import { deterministicSummary } from "./summary.ts";
import { registerCtxCommand, registerPin, registerRecall } from "./tools.ts";

const NOTE =
  "\n\n## Context budget\nOlder tool outputs may appear as \"[context-budget] id=cb-…\" citations " +
  "with a head/tail preview, and large arguments of older tool calls as \"[context-budget] id=ca-…\" " +
  "citations with a head. Your own text and the user's messages are never altered; older thinking is " +
  "archived under th-<hash> and dropped from the prompt (it is re-billed on every resend). Citations " +
  "are snapshots of what was there then. To recover the exact original, call context_budget_recall " +
  "with that id — do not re-run the tool, the world may have changed. Pass list=true for the archive " +
  "catalog. Large snapshots return in chunks; use the next_offset the tool reports. For an elided " +
  "read, re-read the path only if you want the current disk contents.";

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  const states = new Map<string, PlanState>();
  let last: Stats | undefined;
  let lastSessionId: string | undefined;
  let lastWindow = 131072;

  const stateFor = (sessionId: string): PlanState => {
    let s = states.get(sessionId);
    if (!s) states.set(sessionId, (s = loadState(sessionId)));
    return s;
  };
  const sessionIdOf = (ctx: { sessionManager?: { getSessionId?: () => string } } | undefined) =>
    ctx?.sessionManager?.getSessionId?.() ?? lastSessionId;

  pi.on("session_start", (_event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId();
    lastSessionId = sessionId;
    states.set(sessionId, loadState(sessionId));
  });

  pi.on("context", (event, ctx) => {
    if (!cfg.enabled) return;
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      lastSessionId = sessionId;
      const window = ctx.model?.contextWindow ?? 131072;
      lastWindow = window;
      const state = stateFor(sessionId);
      const incoming = stripPin(event.messages as never[]);
      if (cfg.pin && seedScratch(state.scratch, incoming, cfg)) saveState(sessionId, state);
      let base = 0;
      try { base = estimate(ctx.getSystemPrompt(), cfg); } catch { /* not every context exposes it */ }
      const { messages, stats } = plan(incoming, state, cfg, window, spillFor(sessionId), base);
      last = stats;
      if (stats.advanced) saveState(sessionId, state);
      if (process.env.CONTEXT_BUDGET_LOG) {
        const elided = Object.values(state.elided).map((e) => `${e.id}:${e.step}:${e.tool}:${e.tokens}${e.path ? ":spilled" : ""}`);
        appendFileSync(process.env.CONTEXT_BUDGET_LOG, JSON.stringify({ t: new Date().toISOString(), window, gen: state.gen, ...stats, elided }) + "\n");
      }
      if (ctx.hasUI) {
        const pct = Math.round((100 * stats.ctxAfter) / window);
        ctx.ui.setStatus("ctx-budget", stats.elidedTotal > 0 || stats.squeezed ? `ctx ${pct}% −${Math.round(stats.elidedTotal / 1000)}k g${state.gen}` : pct >= 40 ? `ctx ${pct}%` : undefined);
      }
      const pin = cfg.pin ? formatPin(state.scratch) : undefined;
      const out = pin ? [...messages, { role: "user", content: pin }] : messages;
      return { messages: out as never[] };
    } catch (err) {
      console.error(`context-budget: falling back to full context: ${err instanceof Error ? err.message : err}`);
      return;
    }
  });

  pi.on("before_agent_start", (event) => {
    if (!cfg.enabled) return;
    let extra = NOTE;
    if (cfg.pin) extra += ' A trailing "[context-budget pin]" holds the session goal; update it with context_budget_pin.';
    if (cfg.interceptCompact) extra += " If Pi auto-compacts, this extension supplies a deterministic index instead of an LLM summary.";
    return { systemPrompt: event.systemPrompt + extra };
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (!cfg.enabled || !cfg.interceptCompact) return;
    if (event.signal?.aborted) return { cancel: true };
    const sessionId = ctx.sessionManager.getSessionId();
    lastSessionId = sessionId;
    const state = stateFor(sessionId);
    const prep = event.preparation;
    try {
      const summary = deterministicSummary({
        messagesToSummarize: prep.messagesToSummarize as never[],
        turnPrefixMessages: prep.turnPrefixMessages as never[],
        previousSummary: prep.previousSummary,
        fileOps: prep.fileOps,
        tokensBefore: prep.tokensBefore,
        customInstructions: event.customInstructions,
      }, state, cfg);
      if (ctx.hasUI) ctx.ui.notify("context-budget: deterministic compaction (no LLM summary)", "info");
      return {
        compaction: {
          summary,
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
          details: { from: "context-budget", archived: Object.keys(state.elided).length, gen: state.gen },
        },
      };
    } catch (err) {
      console.error(`context-budget: compact intercept failed: ${err instanceof Error ? err.message : err}`);
      return {
        compaction: {
          summary: deterministicSummary({ tokensBefore: prep.tokensBefore }, state, cfg),
          firstKeptEntryId: prep.firstKeptEntryId,
          tokensBefore: prep.tokensBefore,
          details: { from: "context-budget", fallback: true },
        },
      };
    }
  });

  pi.on("session_before_tree", (event, ctx) => {
    if (!cfg.enabled || !cfg.interceptCompact || !event.preparation?.userWantsSummary) return;
    if (event.signal?.aborted) return { cancel: true };
    try {
      const state = stateFor(ctx.sessionManager.getSessionId());
      const msgs = (event.preparation.entriesToSummarize ?? []).flatMap((e) => (e.type === "message" ? [e.message] : []));
      const summary = deterministicSummary({ messagesToSummarize: msgs as never[] }, state, cfg);
      return { summary: { summary, details: { from: "context-budget" } } };
    } catch (err) {
      console.error(`context-budget: tree summary failed: ${err instanceof Error ? err.message : err}`);
      return;
    }
  });

  pi.on("session_compact_failed", (event, ctx) => {
    if (!cfg.enabled) return;
    const msg = event.errorMessage ?? "unknown";
    // Pi reports these for /compact on a session below keepRecentTokens; not a failure.
    if (/too small|Already compacted/i.test(msg)) return;
    console.error(`context-budget: Pi compaction failed (${event.reason ?? "?"}): ${msg}`);
    if (ctx.hasUI) ctx.ui.notify(`context-budget: Pi compact failed: ${msg}`, "warning");
  });

  const host = { cfg, stateFor, sessionIdOf, last: () => last, lastWindow: () => lastWindow };
  registerRecall(pi, host);
  if (cfg.pin) registerPin(pi, host);
  registerCtxCommand(pi, host);
}
