// The two tools and the /ctx command. Everything here reads state through the host callbacks.
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Budget } from "./budget.ts";
import type { Config } from "./config.ts";
import { findElided, formatCatalog, sliceArchive } from "./archive.ts";
import { formatPin, setScratch } from "./pin.ts";
import type { PlanState, Stats } from "./plan.ts";
import { readSpill, saveState, sessionDir } from "./store.ts";

export interface ToolHost {
  cfg: Config;
  stateFor(sessionId: string): PlanState;
  sessionIdOf(ctx: { sessionManager?: { getSessionId?: () => string } } | undefined): string | undefined;
  last(): Stats | undefined;
  lastWindow(): number;
  budget(): Budget;
}

export function registerRecall(pi: ExtensionAPI, host: ToolHost): void {
  const { cfg } = host;
  pi.registerTool({
    name: "context_budget_recall",
    label: "Recall archived context",
    description:
      "Return an exact snapshot of a tool output, tool-call argument or thinking block that context-budget elided. " +
      "Pass id from a [context-budget] citation (cb-…, ca-… or th-…). Pass list=true to list the archive. " +
      "Large snapshots are chunked; pass offset from next_offset to continue. Do not re-run the " +
      "original tool to recover historical output.",
    promptSnippet: "Recall an elided tool output, argument or thinking snapshot by context-budget id",
    promptGuidelines: [
      "When a [context-budget] citation has the id you need, call context_budget_recall rather than re-running the tool.",
      "Use list=true if you need to find an id. Use offset to page through a large snapshot.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Archive id from a citation, e.g. cb-a1b2c3d4, ca-a1b2c3d4 or th-0f3a9c1d2e4b." })),
      list: Type.Optional(Type.Boolean({ description: "If true, return the archive catalog instead of a snapshot." })),
      offset: Type.Optional(Type.Integer({ description: "Character offset into the snapshot (from next_offset)." })),
      limit: Type.Optional(Type.Integer({ description: `Max characters to return (default ${cfg.recallLimitChars}).` })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = host.sessionIdOf(ctx);
      const state = sessionId ? host.stateFor(sessionId) : { elided: {} };
      const p = params as { id?: string; list?: boolean; offset?: number; limit?: number };
      if (p.list || !p.id) return { content: [{ type: "text", text: formatCatalog(state.elided) }], details: { catalog: true } };
      const e = findElided(state.elided, p.id);
      if (!e) return { content: [{ type: "text", text: `Unknown id ${p.id}. Archive:\n${formatCatalog(state.elided)}` }], details: { unknown: p.id } };
      const text = readSpill(e.path);
      if (text == null) {
        return { content: [{ type: "text", text: `id=${e.id} is catalogued (${e.tool} step ${e.step}) but the snapshot file is missing.` }], details: { missing: e.path } };
      }
      const chunk = sliceArchive(text, p.offset ?? 0, p.limit ?? cfg.recallLimitChars);
      const header = `[context-budget] id=${e.id}  ${e.tool}  step ${e.step}  ${chunk.offset}/${chunk.total} chars` +
        (chunk.next != null ? `  next_offset=${chunk.next}` : "  end");
      return { content: [{ type: "text", text: `${header}\n${chunk.body}` }], details: { id: e.id, next: chunk.next, total: chunk.total } };
    },
  });
}

export function registerPin(pi: ExtensionAPI, host: ToolHost): void {
  pi.registerTool({
    name: "context_budget_pin",
    label: "Pin session goal",
    description:
      "Set the tiny session pin (goal + a few notes) that is re-injected at the end of every request. " +
      "This is not a task list and not long-term memory. Keep it under the character cap. Pass notes as " +
      "short bullets. Omit a field to leave it unchanged; pass notes=\"\" to clear notes.",
    promptSnippet: "Update the short session goal/notes pin",
    promptGuidelines: [
      "Use context_budget_pin for the current user ask and a handful of constraints, not a todo list.",
    ],
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "One-line session goal. Omit to keep the current goal." })),
      notes: Type.Optional(Type.String({ description: "Short notes (newlines ok). Replaces the notes field." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = host.sessionIdOf(ctx);
      if (!sessionId) return { content: [{ type: "text", text: "No session id; pin not saved." }], details: {} };
      const state = host.stateFor(sessionId);
      const result = setScratch(state.scratch, params as { goal?: string; notes?: string }, host.cfg);
      if (!result.ok) return { content: [{ type: "text", text: result.error ?? "pin rejected" }], details: { error: true } };
      saveState(sessionId, state);
      const pin = formatPin(state.scratch) ?? "(empty)";
      return { content: [{ type: "text", text: pin }], details: { chars: pin.length } };
    },
  });
}

// Pi compacts above `trigger`; the plan aims to stay under `cap`. When Pi's threshold is the lower
// of the two the configured target is unreachable, so the cap is pulled under it and squeeze is on.
function budgetLine(host: ToolHost): string {
  const b = host.budget();
  const trigger = Number.isFinite(b.trigger) ? `${b.trigger}` : "off";
  return `plan cap ${Math.round(b.cap)} tokens (${Math.round((100 * b.cap) / (host.lastWindow() || 1))}%) · Pi compacts above ${trigger}` +
    (b.clamped ? " · cap clamped under Pi's threshold, squeeze forced on" : "");
}

export function registerCtxCommand(pi: ExtensionAPI, host: ToolHost): void {
  const { cfg } = host;
  pi.registerCommand("ctx", {
    description: "context-budget: show what is being elided and why",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const state = host.stateFor(sessionId);
      const usage = ctx.getContextUsage();
      const last = host.last();
      const window = usage?.contextWindow ?? host.lastWindow();
      const pct = last ? Math.round((100 * last.ctxAfter) / window) : usage?.percent;
      const counts = Object.values(state.elided).reduce((n, e) => ({ ...n, [e.kind]: (n[e.kind] ?? 0) + 1 }), {} as Record<string, number>);
      const lines = [
        `context window ${window ?? "?"} · provider-reported ${usage?.tokens ?? "?"} tokens (${usage?.percent?.toFixed(0) ?? "?"}%) · plugin sent ${last ? last.ctxAfter : "?"} est (${pct ?? "?"}%)`,
        last
          ? `last request: ${last.ctxBefore} est → ${last.ctxAfter} sent · ${last.resultsElided} results · ${last.argsElided} arguments · ${last.thinkingDropped} thinking blocks elided · squeezed ${last.squeezed} · ${last.eligibleWaiting} tokens waiting for next batch`
          : "no request yet",
        budgetLine(host),
        `plan generation ${state.gen} · squeeze ${host.budget().cfg.squeeze} · pin ${cfg.pin} · interceptCompact ${cfg.interceptCompact} · thinking kept ${cfg.keepThinkingSteps} · results kept ${cfg.keepRecentSteps}`,
        cfg.pin ? `pin: ${state.scratch.goal ? state.scratch.goal.slice(0, 120) : "(none)"}` : undefined,
        `archive ${counts.result ?? 0} results · ${counts.arg ?? 0} arguments · ${counts.thinking ?? 0} thinking · recall with context_budget_recall · spill dir ${sessionDir(sessionId)}`,
      ].filter((l): l is string => Boolean(l));
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
