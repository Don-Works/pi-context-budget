// context-budget — keeps a long Pi session inside the window the model works best in,
// without paraphrasing anything: old thinking is archived and dropped from the prompt,
// stale tool outputs become addressable citations pointing at a spill snapshot.
// Pure logic lives in ./plan.ts.
//
// Config: ~/.pi/agent/context-budget.json (any subset of DEFAULTS), or the file named
// by CONTEXT_BUDGET_CONFIG. Per-request stats go to CONTEXT_BUDGET_LOG when set.
import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULTS,
  deterministicSummary,
  emptyScratch,
  findElided,
  formatCatalog,
  formatPin,
  newState,
  plan,
  seedScratch,
  setScratch,
  sliceArchive,
  stripPin,
  type Config,
  type PlanState,
  type Stats,
} from "./plan.ts";

const SPILL_ROOT = join(homedir(), ".pi", "agent", "context-budget");
const NOTE =
  "\n\n## Context budget\nOlder tool outputs may appear as \"[context-budget] id=cb-…\" citations " +
  "with a head/tail preview. Your own messages and the user's messages are never altered; older " +
  "thinking is archived under th-<step> and dropped from the prompt (it is re-billed on every " +
  "resend). Citations are snapshots of what the tool returned then. To recover the exact original, " +
  "call context_budget_recall with that id — do not re-run the tool, the world may have changed. " +
  "Pass list=true for the archive catalog. Large snapshots return in chunks; use the next_offset " +
  "the tool reports. For an elided read, re-read the path only if you want the current disk contents.";

function loadConfig(): Config {
  const path = process.env.CONTEXT_BUDGET_CONFIG ?? join(homedir(), ".pi", "agent", "context-budget.json");
  try {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      const merged = { ...DEFAULTS, ...raw } as Config;
      if (raw.stubHeadChars == null && typeof raw.errorHeadChars === "number") {
        merged.stubHeadChars = raw.errorHeadChars;
      }
      return merged;
    }
  } catch (err) {
    console.error(`context-budget: ignoring ${path}: ${err instanceof Error ? err.message : err}`);
  }
  return { ...DEFAULTS };
}

function sessionDir(sessionId: string): string {
  return join(SPILL_ROOT, sessionId);
}

function statePath(sessionId: string): string {
  return join(sessionDir(sessionId), "state.json");
}

function loadState(sessionId: string): PlanState {
  try {
    const p = statePath(sessionId);
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<PlanState>;
      return {
        elided: raw.elided ?? {},
        thinkCut: raw.thinkCut ?? 0,
        gen: raw.gen ?? 0,
        scratch: raw.scratch ?? emptyScratch(),
      };
    }
  } catch (err) {
    console.error(`context-budget: ignoring ${statePath(sessionId)}: ${err instanceof Error ? err.message : err}`);
  }
  return newState();
}

function saveState(sessionId: string, state: PlanState): void {
  try {
    mkdirSync(sessionDir(sessionId), { recursive: true, mode: 0o700 });
    writeFileSync(statePath(sessionId), JSON.stringify(state), { mode: 0o600 });
  } catch (err) {
    console.error(`context-budget: could not persist state: ${err instanceof Error ? err.message : err}`);
  }
}

function readSpill(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  return readFileSync(path, "utf8");
}

export default function (pi: ExtensionAPI) {
  const cfg = loadConfig();
  const states = new Map<string, PlanState>();
  let last: Stats | undefined;
  let lastSessionId: string | undefined;
  let lastWindow = 131072;

  const stateFor = (sessionId: string) => {
    let s = states.get(sessionId);
    if (!s) states.set(sessionId, (s = loadState(sessionId)));
    return s;
  };

  const spillFor = (sessionId: string) => (id: string, tool: string, step: number, text: string) => {
    try {
      const dir = sessionDir(sessionId);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const slug = id.replace(/[^A-Za-z0-9:_-]/g, "").slice(-12);
      const path = join(dir, `${String(step).padStart(3, "0")}-${tool}-${slug}.txt`);
      if (!existsSync(path)) writeFileSync(path, text, { mode: 0o600 });
      return path;
    } catch {
      return undefined;
    }
  };

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
      const { messages, stats } = plan(incoming, state, cfg, window, spillFor(sessionId));
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
    if (cfg.pin) {
      extra += ' A trailing "[context-budget pin]" holds the session goal; update it with context_budget_pin.';
    }
    if (cfg.interceptCompact) {
      extra += " If Pi auto-compacts, this extension supplies a deterministic index instead of an LLM summary.";
    }
    return { systemPrompt: event.systemPrompt + extra };
  });

  pi.on("session_before_compact", (event, ctx) => {
    if (!cfg.enabled || !cfg.interceptCompact) return;
    if (event.signal?.aborted) return { cancel: true };
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      lastSessionId = sessionId;
      const state = stateFor(sessionId);
      const prep = event.preparation ?? {};
      const summary = deterministicSummary({
        messagesToSummarize: prep.messagesToSummarize,
        turnPrefixMessages: prep.turnPrefixMessages,
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
          summary: deterministicSummary({}, stateFor(ctx.sessionManager.getSessionId()), cfg),
          firstKeptEntryId: event.preparation?.firstKeptEntryId,
          tokensBefore: event.preparation?.tokensBefore,
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
      const msgs = (event.preparation.entriesToSummarize ?? [])
        .filter((e: { type?: string; message?: unknown }) => e?.type === "message" && e.message)
        .map((e: { message: unknown }) => e.message);
      const summary = deterministicSummary({
        messagesToSummarize: msgs as never[],
        tokensBefore: event.preparation.tokensBefore,
      }, state, cfg);
      return { summary: { summary, details: { from: "context-budget" } } };
    } catch (err) {
      console.error(`context-budget: tree summary failed: ${err instanceof Error ? err.message : err}`);
      return;
    }
  });

  pi.on("session_compact_failed", (event, ctx) => {
    if (!cfg.enabled) return;
    const msg = event.errorMessage ?? "unknown";
    // Pi throws this when /compact is run below keepRecentTokens. Not a real failure.
    if (/too small|Already compacted/i.test(msg)) return;
    console.error(`context-budget: Pi compaction failed (${event.reason ?? "?"}): ${msg}`);
    if (ctx.hasUI) ctx.ui.notify(`context-budget: Pi compact failed: ${msg}`, "warning");
  });

  pi.registerTool({
    name: "context_budget_recall",
    label: "Recall archived context",
    description:
      "Return an exact snapshot of a tool output or thinking block that context-budget elided. " +
      "Pass id from a [context-budget] citation (cb-… or th-…). Pass list=true to list the archive. " +
      "Large snapshots are chunked; pass offset from next_offset to continue. Do not re-run the " +
      "original tool to recover historical output.",
    promptSnippet: "Recall an elided tool output or thinking snapshot by context-budget id",
    promptGuidelines: [
      "When a [context-budget] citation has the id you need, call context_budget_recall rather than re-running the tool.",
      "Use list=true if you need to find an id. Use offset to page through a large snapshot.",
    ],
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Archive id from a citation, e.g. cb-a1b2c3d4 or th-3." })),
      list: Type.Optional(Type.Boolean({ description: "If true, return the archive catalog instead of a snapshot." })),
      offset: Type.Optional(Type.Integer({ description: "Character offset into the snapshot (from next_offset)." })),
      limit: Type.Optional(Type.Integer({ description: `Max characters to return (default ${cfg.recallLimitChars}).` })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx?.sessionManager?.getSessionId?.() ?? lastSessionId;
      const state = sessionId ? stateFor(sessionId) : newState();
      const p = params as { id?: string; list?: boolean; offset?: number; limit?: number };
      if (p.list || !p.id) {
        return { content: [{ type: "text", text: formatCatalog(state) }], details: { catalog: true } };
      }
      const e = findElided(state, p.id);
      if (!e) {
        const catalog = formatCatalog(state);
        return {
          content: [{ type: "text", text: `Unknown id ${p.id}. Archive:\n${catalog}` }],
          details: { unknown: p.id },
        };
      }
      const text = readSpill(e.path);
      if (text == null) {
        return {
          content: [{ type: "text", text: `id=${e.id} is catalogued (${e.tool} step ${e.step}) but the snapshot file is missing.` }],
          details: { missing: e.path },
        };
      }
      const chunk = sliceArchive(text, p.offset ?? 0, p.limit ?? cfg.recallLimitChars);
      const header = `[context-budget] id=${e.id}  ${e.tool}  step ${e.step}  ${chunk.offset}/${chunk.total} chars` +
        (chunk.next != null ? `  next_offset=${chunk.next}` : "  end");
      return { content: [{ type: "text", text: `${header}\n${chunk.body}` }], details: { id: e.id, next: chunk.next, total: chunk.total } };
    },
  });

  if (cfg.pin) pi.registerTool({
    name: "context_budget_pin",
    label: "Pin session goal",
    description:
      "Set the tiny session pin (goal + a few notes) that is re-injected at the end of every request. " +
      "This is not a task list and not long-term memory. Keep it under the character cap. Pass notes as " +
      "short bullets. Omit a field to leave it unchanged; pass notes=\"\" to clear notes.",
    promptSnippet: "Update the short session goal/notes pin",
    promptGuidelines: [
      "Use context_budget_pin for the current user ask and a handful of constraints, not a todo list.",
      "Do not file an mcplexer task for session-local intent that dies with this chat.",
    ],
    parameters: Type.Object({
      goal: Type.Optional(Type.String({ description: "One-line session goal. Omit to keep the current goal." })),
      notes: Type.Optional(Type.String({ description: "Short notes (newlines ok). Replaces the notes field." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = ctx?.sessionManager?.getSessionId?.() ?? lastSessionId;
      if (!sessionId) return { content: [{ type: "text", text: "No session id; pin not saved." }], details: {} };
      const state = stateFor(sessionId);
      const p = params as { goal?: string; notes?: string };
      const result = setScratch(state.scratch, p, cfg);
      if (!result.ok) return { content: [{ type: "text", text: result.error ?? "pin rejected" }], details: { error: true } };
      saveState(sessionId, state);
      const pin = formatPin(state.scratch) ?? "(empty)";
      return { content: [{ type: "text", text: pin }], details: { chars: pin.length } };
    },
  });

  pi.registerCommand("ctx", {
    description: "context-budget: show what is being elided and why",
    handler: async (_args, ctx) => {
      const state = stateFor(ctx.sessionManager.getSessionId());
      const usage = ctx.getContextUsage();
      const archived = Object.keys(state.elided).length;
      const window = usage?.contextWindow ?? lastWindow;
      const pct = last ? Math.round((100 * last.ctxAfter) / window) : usage?.percent;
      const lines = [
        `context window ${window ?? "?"} · provider-reported ${usage?.tokens ?? "?"} tokens (${usage?.percent?.toFixed(0) ?? "?"}%) · plugin sent ${last ? last.ctxAfter : "?"} est (${pct ?? "?"}%)`,
        last ? `last request: ${last.ctxBefore} est → ${last.ctxAfter} sent · ${last.resultsElided} results stubbed · ${last.thinkingDropped} thinking blocks dropped · squeezed ${last.squeezed} · ${last.eligibleWaiting} tokens waiting for next batch` : "no request yet",
        `plan generation ${state.gen} · squeeze ${cfg.squeeze} · pin ${cfg.pin} · interceptCompact ${cfg.interceptCompact} · thinking kept ${cfg.keepThinkingSteps} · results kept ${cfg.keepRecentSteps}`,
        cfg.pin ? `pin: ${state.scratch.goal ? state.scratch.goal.slice(0, 120) : "(none)"}` : undefined,
        `archive ${archived} items · recall with context_budget_recall · spill dir ${sessionDir(ctx.sessionManager.getSessionId())}`,
      ].filter((l): l is string => Boolean(l));
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
