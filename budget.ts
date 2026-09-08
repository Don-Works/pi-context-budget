// Where this plan's budget has to sit relative to Pi's own compaction threshold. Pure; no Pi imports.
//
// Pi compacts when the prompt passes contextWindow - reserveTokens, and its cut point keeps
// keepRecentTokens of the tail (core/compaction: shouldCompact, findCutPoint). Both are global
// settings — the same numbers for every model, with no per-model override. On a 262144-token
// window the default 16384 reserve puts the threshold at 94%, far above this extension's 60%
// target, and the two never meet. On a 32768-token model the same reserve puts it at 50%, below
// the target: Pi then compacts on every request however well the plan is doing. If
// keepRecentTokens is also larger than the window, the cut point keeps everything, each compaction
// frees a few hundred tokens and the next request compacts again.
import type { Config } from "./config.ts";

export interface PiCompaction {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

// Pi's own fallbacks (core/settings-manager.js) for keys settings.json leaves out.
export const PI_COMPACTION_DEFAULTS: PiCompaction = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 };

const MAX_HEADROOM = 4096;        // tokens left between the plan's cap and Pi's threshold
const MIN_TARGET_FRACTION = 0.2;  // never aim below this, however little reserve leaves us
const MIN_KEEP_TOKENS = 1000;

export function piCompactionFrom(raw: unknown): PiCompaction {
  const block = (raw as { compaction?: Record<string, unknown> } | undefined)?.compaction;
  const num = (v: unknown, dflt: number) => (typeof v === "number" && v > 0 ? v : dflt);
  return {
    enabled: typeof block?.enabled === "boolean" ? block.enabled : PI_COMPACTION_DEFAULTS.enabled,
    reserveTokens: num(block?.reserveTokens, PI_COMPACTION_DEFAULTS.reserveTokens),
    keepRecentTokens: num(block?.keepRecentTokens, PI_COMPACTION_DEFAULTS.keepRecentTokens),
  };
}

// The prompt size above which Pi runs a compaction. Infinity when Pi's compaction is off.
export function compactionTrigger(pi: PiCompaction, contextWindow: number): number {
  return pi.enabled && contextWindow > 0 ? Math.max(0, contextWindow - pi.reserveTokens) : Number.POSITIVE_INFINITY;
}

export interface Budget {
  cfg: Config;        // the plan config to actually use for this window
  clamped: boolean;   // true when Pi's threshold, not the configured target, set the cap
  trigger: number;    // Pi compacts above this many tokens
  cap: number;        // the plan aims to stay at or below this many tokens
  keepTokens: number; // tail to keep when we have to pick a cut point ourselves
}

// Unchanged on any window where the configured target already sits below Pi's threshold, which is
// every window large enough that reserveTokens is a small share of it. Below that, the target is
// pulled under the threshold and squeeze is turned on, because a target the plan will not enforce
// leaves Pi compacting on every request.
export function budgetFor(cfg: Config, contextWindow: number, pi: PiCompaction): Budget {
  const trigger = compactionTrigger(pi, contextWindow);
  const keepTokens = Math.max(MIN_KEEP_TOKENS, Math.min(pi.keepRecentTokens, Math.round((trigger - headroom(contextWindow)) / 2)));
  const plain = { cfg, clamped: false, trigger, cap: cfg.targetFraction * contextWindow, keepTokens };
  if (!cfg.enabled || !(contextWindow > 0) || !Number.isFinite(trigger)) return plain;
  const capFraction = (trigger - headroom(contextWindow)) / contextWindow;
  if (capFraction >= cfg.targetFraction) return plain;
  const target = Math.max(capFraction, MIN_TARGET_FRACTION);
  return {
    cfg: {
      ...cfg,
      targetFraction: target,
      highWaterFraction: Math.min(cfg.highWaterFraction, target),
      startAtFraction: Math.min(cfg.startAtFraction, target / 2),
      squeeze: true,
    },
    clamped: true,
    trigger,
    cap: target * contextWindow,
    keepTokens,
  };
}

function headroom(contextWindow: number): number {
  return Math.min(Math.round(0.1 * contextWindow), MAX_HEADROOM);
}

// Tokens a compaction has to free for the prompt to come back under the threshold that fired it.
// Below this the same decision is made again next request: Pi's cut point is anchored to
// keepRecentTokens from the end of the branch, so it does not move on its own.
export function tokensToFree(tokensBefore: number, trigger: number): number {
  return Number.isFinite(trigger) ? Math.max(0, tokensBefore - trigger) : 0;
}
