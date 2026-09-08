// What a compaction should discard, and whether it is worth running at all. Pure; no Pi imports.
import { tokensToFree, type Budget } from "./budget.ts";
import { estimate, type Config } from "./config.ts";
import { boundaryStart, indexOfEntry, recut, spanMessages, type Entry } from "./cut.ts";
import { estimateMessages, type Msg } from "./messages.ts";
import { deterministicSummary, type CompactInput, type SummaryState } from "./summary.ts";

export interface Preparation {
  firstKeptEntryId: string;
  messagesToSummarize?: Msg[];
  turnPrefixMessages?: Msg[];
  tokensBefore?: number;
  previousSummary?: string;
  fileOps?: CompactInput["fileOps"];
}

export interface Span {
  firstKeptEntryId: string;
  messagesToSummarize: Msg[];
  turnPrefixMessages: Msg[];
  tokens: number;
  recut: boolean;
}

// Pi's cut keeps keepRecentTokens of the tail, a global setting that can exceed a small model's
// whole window; then the cut lands at the head of the branch and the compaction discards almost
// nothing. When Pi's span is smaller than what has to be freed, take a cut sized to the window.
export function spanFor(prep: Preparation, entries: Entry[], budget: Budget, need: number, cfg: Config): Span {
  const own: Span = {
    firstKeptEntryId: prep.firstKeptEntryId,
    messagesToSummarize: prep.messagesToSummarize ?? [],
    turnPrefixMessages: prep.turnPrefixMessages ?? [],
    tokens: estimateMessages([...(prep.messagesToSummarize ?? []), ...(prep.turnPrefixMessages ?? [])], cfg),
    recut: false,
  };
  if (own.tokens >= need) return own;
  const cut = recut(entries, indexOfEntry(entries, prep.firstKeptEntryId), budget.keepTokens, cfg);
  if (!cut) return own;
  const wider = spanMessages(entries, boundaryStart(entries), cut.index);
  const tokens = estimateMessages(wider, cfg);
  if (tokens <= own.tokens) return own;
  return { firstKeptEntryId: cut.id, messagesToSummarize: wider, turnPrefixMessages: [], tokens, recut: true };
}

export interface Decision {
  cancel: boolean;
  summary: string;
  firstKeptEntryId: string;
  freed: number;   // tokens this compaction would remove from the prompt
  need: number;    // tokens it has to remove to get back under Pi's threshold
  recut: boolean;
}

// A threshold compaction that cannot get back under the threshold that fired it will fire again
// next request on the same branch, and the one after that: Pi's cut point is anchored to
// keepRecentTokens from the end, so it does not move on its own. Cancel that one rather than write
// an index entry every turn. Manual and overflow compactions always run — overflow is the turn that
// already failed for size, and cancelling it would only fail it again.
export function decideCompaction(args: {
  prep: Preparation;
  entries: Entry[];
  budget: Budget;
  reason: string;
  state: SummaryState;
  cfg: Config;
  customInstructions?: string;
}): Decision {
  const { prep, entries, budget, reason, state, cfg } = args;
  const need = tokensToFree(prep.tokensBefore ?? 0, budget.trigger);
  const span = spanFor(prep, entries, budget, need, cfg);
  const summary = deterministicSummary({
    messagesToSummarize: span.messagesToSummarize,
    turnPrefixMessages: span.turnPrefixMessages,
    previousSummary: prep.previousSummary,
    fileOps: prep.fileOps,
    tokensBefore: prep.tokensBefore,
    customInstructions: args.customInstructions,
  }, state, cfg);
  const freed = span.tokens - estimate(summary, cfg);
  return { cancel: reason === "threshold" && freed < need, summary, firstKeptEntryId: span.firstKeptEntryId, freed, need, recut: span.recut };
}
