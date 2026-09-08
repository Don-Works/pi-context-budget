// context-budget configuration. Pure; no Pi imports.
export interface Config {
  enabled: boolean;
  startAtFraction: number;      // do nothing below this fraction of the context window
  highWaterFraction: number;    // above this, advance the plan as soon as anything is eligible
  targetFraction: number;       // squeeze target, used only when squeeze is on
  keepRecentSteps: number;      // tool results/arguments younger than this (assistant steps) are untouched; min 1
  keepThinkingSteps: number;    // thinking kept for this many most recent assistant steps
  minResultTokens: number;      // smaller tool results are never elided
  leanAfterSteps: number;       // an elided result this many steps old drops to a one-line index entry; 0 disables
  leanMinTokens: number;        // ...and results this small are left alone even then
  reduceSearch: boolean;        // reduce tool-search results to top hits + names instead of head/tail
  searchKeepTop: number;        // hits kept with their description per query block
  argMinTokens: number;         // tool-call string arguments larger than this are archived; 0 disables
  batchTokens: number;          // advance the plan only when >= this many tokens can be elided
  thinkBatchSteps: number;      // ...or when this many thinking blocks became eligible
  protectLatestReadTokens: number; // budget for keeping the latest un-superseded read per path
  stubHeadChars: number;        // citation keeps up to this many leading chars of the original
  stubTailChars: number;        // ...and up to this many trailing chars (errors always keep the tail)
  argHeadChars: number;         // archived argument keeps this many leading chars in the call
  recallLimitChars: number;     // default chunk size for addressable recall
  emergencyKeepSteps: number;   // squeeze tries to keep this many recent result steps
  emergencyKeepThinking: number;// squeeze drops thinking to this many recent steps
  scratchLimitChars: number;    // hard cap for the session pin
  squeeze: boolean;             // off by default: emergency elide down to targetFraction
  pin: boolean;                 // off by default: trailing session goal pin
  interceptCompact: boolean;    // on by default: replace Pi LLM compaction with a deterministic index
  charsPerToken: number;
}

export const DEFAULTS: Config = {
  enabled: true,
  startAtFraction: 0.3,
  highWaterFraction: 0.6,
  targetFraction: 0.6,
  keepRecentSteps: 8,
  keepThinkingSteps: 6,
  minResultTokens: 300,
  leanAfterSteps: 24,
  leanMinTokens: 60,
  reduceSearch: true,
  searchKeepTop: 3,
  argMinTokens: 150,
  batchTokens: 6000,
  thinkBatchSteps: 4,
  protectLatestReadTokens: 12000,
  stubHeadChars: 400,
  stubTailChars: 400,
  argHeadChars: 160,
  recallLimitChars: 24000,
  emergencyKeepSteps: 2,
  emergencyKeepThinking: 1,
  scratchLimitChars: 1500,
  squeeze: false,
  pin: false,
  interceptCompact: true,
  charsPerToken: 3.3,
};

export function estimate(text: string, cfg: Config): number {
  return Math.ceil(text.length / cfg.charsPerToken);
}

// Accepts a raw JSON object: unknown keys are ignored, the pre-0.2 errorHeadChars key still works.
export function mergeConfig(raw: Record<string, unknown>): Config {
  const merged: Config = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof Config)[]) {
    const v = raw[k];
    if (typeof v === typeof DEFAULTS[k]) (merged as unknown as Record<string, unknown>)[k] = v;
  }
  if (raw.stubHeadChars == null && typeof raw.errorHeadChars === "number") merged.stubHeadChars = raw.errorHeadChars;
  merged.keepRecentSteps = Math.max(1, merged.keepRecentSteps);
  merged.searchKeepTop = Math.max(0, merged.searchKeepTop);
  merged.leanAfterSteps = Math.max(0, merged.leanAfterSteps);
  merged.leanMinTokens = Math.max(0, merged.leanMinTokens);
  merged.charsPerToken = merged.charsPerToken > 0 ? merged.charsPerToken : DEFAULTS.charsPerToken;
  return merged;
}
