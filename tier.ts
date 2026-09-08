// How a result is rendered in the prompt, and what each tier saves. Pure; no Pi imports.
//
// A result passes through at most three tiers, and only ever downwards:
//
//   reduced  a projection of the result's own structure (tool-search: top hits + names).
//            Not age-gated — it is the same list, not a summary of it, so nothing the model
//            is about to act on is lost.
//   cite     the head/tail citation. The default for unstructured output.
//   lean     one index line: id, tool, step, size. The tool call it answers is still in the
//            prompt beside it, which for a shell result is the command itself.
//
// Measured over 36 recorded sessions of 60+ steps: once everything eligible is a citation the
// prompt still carries 524k tokens of citations plus 331k of results under minResultTokens
// that are never elided at all. The lean tier is what stops the citations becoming the context.
import { estimate, type Config } from "./config.ts";
import { archiveId, stubFor, tierOf, type Elided, type Spill, type Tier } from "./archive.ts";
import { isToolSearch, leanStub, reduceResult, reducedStub } from "./reduce.ts";
import { resultText, type Index, type Msg, type ResultInfo } from "./messages.ts";
import type { PlanState } from "./plan.ts";

export interface Host {
  messages: Msg[];
  state: PlanState;
  cfg: Config;
  spill: Spill;
  latest: Map<string, string>;   // call signature -> id of the latest call with it
  recalled: Set<string>;         // archive ids the model asked back
  stubTokens: Map<string, number>; // exact sent size per item and tier, memoized for this request
}

const RANK: Record<Tier, number> = { reduced: 0, cite: 1, lean: 2 };

// Shape test only. This runs for every un-elided result on every request, so it must not
// build the reduction just to find out whether one exists; isToolSearch fails on a substring
// check for anything that is not a search result.
export function isReducible(h: Host, r: ResultInfo): boolean {
  return h.cfg.reduceSearch && isToolSearch(resultText(h.messages[r.idx]));
}

export function targetTier(h: Host, r: ResultInfo): Tier {
  return isReducible(h, r) ? "reduced" : "cite";
}

// The exact text that will be sent for this result at this tier. Savings are measured against
// it, not against an estimate of it, so the squeeze cap is a real cap at every tier.
export function sentFor(h: Host, r: ResultInfo, tier: Tier, e: Elided): string {
  if (tier === "lean") return leanStub(r, e);
  const text = resultText(h.messages[r.idx]);
  if (tier === "reduced") {
    const body = reduceResult(text, h.cfg);
    if (body) return reducedStub(r, e, body, h.cfg);
  }
  return stubFor(r, text, e, h.cfg);
}

export function entryFor(h: Host, r: ResultInfo, path?: string, tier: Tier = "cite"): Elided {
  const later = h.latest.get(r.sig);
  const duplicateOf = later && later !== r.id ? archiveId(later) : undefined;
  return { id: archiveId(r.id), kind: "result", path, step: r.step, tool: r.tool, tokens: r.tokens, duplicateOf, tier };
}

export function savingsAt(h: Host, r: ResultInfo, tier: Tier): number {
  const key = `${r.id}:${tier}`;
  let stub = h.stubTokens.get(key);
  if (stub == null) {
    const e = h.state.elided[r.id] ?? entryFor(h, r, "pending");
    stub = estimate(sentFor(h, r, tier, { ...e, tier }), h.cfg);
    h.stubTokens.set(key, stub);
  }
  return Math.max(0, r.tokens - stub);
}

// What a result saves right now, at whatever tier it currently sits in. Zero if untouched.
export function currentSavings(h: Host, r: ResultInfo): number {
  const t = tierOf(h.state.elided[r.id]);
  return t ? savingsAt(h, r, t) : 0;
}

// The extra tokens a demotion to `tier` would free beyond what this result already saves.
export function gainAt(h: Host, r: ResultInfo, tier: Tier): number {
  return Math.max(0, savingsAt(h, r, tier) - currentSavings(h, r));
}

// Archives the result if it is not archived yet, then demotes it. Demotion is one-way: a tier
// is only ever replaced by a lower-ranked one, so the plan keeps its "only ever grows" property
// and the prompt cannot thrash between tiers on successive requests.
export function placeAt(h: Host, r: ResultInfo, tier: Tier): void {
  const e = h.state.elided[r.id];
  if (!e) {
    const text = resultText(h.messages[r.idx]);
    h.state.elided[r.id] = entryFor(h, r, h.spill(r.id, r.tool, r.step, text), tier);
    return;
  }
  if (RANK[tier] > RANK[tierOf(e) ?? "cite"]) e.tier = tier;
}

export interface LeanOpts {
  after: number;           // steps of age before a result may drop to a lean line
  includeErrors: boolean;  // errors keep their tail unless the squeeze is desperate
  protect: Set<string>;    // protected latest reads, never leaned
}

// Includes results that were never elided at all: with a ~20-token index line, a 250-token
// result under minResultTokens is worth demoting, which the ~290-token citation never was.
export function leanCandidates(h: Host, ix: Index, last: number, o: LeanOpts): ResultInfo[] {
  const { cfg, state } = h;
  if (!(cfg.leanAfterSteps > 0)) return [];
  return ix.results.filter((r) => {
    if (tierOf(state.elided[r.id]) === "lean") return false;
    if (last - r.step < o.after) return false;
    if (r.hasImage || (r.isError && !o.includeErrors)) return false;
    if (r.tokens <= cfg.leanMinTokens) return false;
    if (o.protect.has(r.id)) return false;
    if (h.recalled.has(archiveId(r.id))) return false;
    return gainAt(h, r, "lean") > 0;
  });
}
