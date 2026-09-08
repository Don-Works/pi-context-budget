// Typed result reducers: a projection of a result's own structure, used instead of the
// head/tail citation where the shape is known. Pure; no Pi imports.
//
// Head/tail is the right stub for unstructured output and the wrong one for a ranked list.
// On a tool-search result it spends its whole budget on the first two and last two hits —
// measured over 146 recorded searches, 3544 tools were listed and 203 were ever invoked
// (5.7%), and rank 6+ hits are used 4.0% of the time. So the reduction keeps the top few
// hits with their descriptions and the rest as bare names: enough to pick a tool, and
// enough to remember the query was already run, which is what stops a re-search.
import { estimate, type Config } from "./config.ts";
import type { Elided } from "./archive.ts";

// "- [0.69] task__create — Create a task …" (summary mode) or "- task__create — …" (full mode).
const HIT = /^\s*-\s*(?:\[(\d+(?:\.\d+)?)\]\s*)?([A-Za-z0-9_]+__[A-Za-z0-9_]+)\s+—\s?(.*)$/;
const QUERY_HEAD = "## Results for ";

interface Block {
  head: string;
  kept: string[];
  names: string[];
}

export function isToolSearch(text: string): boolean {
  if (!text.includes(QUERY_HEAD)) return false;
  for (const line of text.split("\n")) if (HIT.test(line)) return true;
  return false;
}

// Keeps the first `keepTop` hits of each query block verbatim and lists the rest by name.
// A "## Code API" block (the TypeScript signature dump, capped at 24000 bytes by the
// gateway) is dropped entirely — it is the single largest part and recall returns it.
export function reduceToolSearch(text: string, keepTop: number): string | null {
  const keep = Math.max(0, keepTop);
  const out: string[] = [];
  let block: Block | null = null;
  let dropped = 0;
  let skipping = false;

  const flush = () => {
    if (!block) return;
    out.push(block.head, ...block.kept);
    if (block.names.length) out.push(`also: ${block.names.join(", ")}`);
    block = null;
  };

  for (const line of text.split("\n")) {
    if (line.startsWith(QUERY_HEAD)) {
      flush();
      skipping = false;
      block = { head: line, kept: [], names: [] };
      continue;
    }
    if (line.startsWith("## ")) {
      flush();
      skipping = true; // "## Code API" and anything else that is not a result block
      continue;
    }
    if (skipping) {
      if (line.trim()) dropped++;
      continue;
    }
    if (!block || line.startsWith("### ")) continue; // namespace headers: the names carry the namespace
    const m = HIT.exec(line);
    if (!m) continue;
    const score = m[1] ? `[${m[1]}] ` : "";
    if (block.kept.length < keep) block.kept.push(`- ${score}${m[2]} — ${m[3]}`);
    else block.names.push(m[2]);
  }
  flush();
  if (!out.length) return null;
  if (dropped) out.push(`(${dropped} lines of TypeScript signatures dropped)`);
  return out.join("\n");
}

export interface ReducedInfo {
  tool: string;
  step: number;
  tokens: number;
}

export function reducedStub(r: ReducedInfo, e: Elided, body: string, cfg: Config): string {
  return `[context-budget] id=${e.id}  ${r.tool}  step ${r.step}  ${r.tokens} tokens → ${estimate(body, cfg)} kept\n${body}\n` +
    `Top hits kept with descriptions; the rest are names only. Full descriptions and signatures: context_budget_recall id=${e.id}.`;
}

// The cheapest tier: identity and size, no preview. The tool call it answers is still in the
// prompt next to it, so for a shell result the command itself is what says whether to recall.
export function leanStub(r: { tool: string; step: number; tokens: number; path?: string }, e: Elided): string {
  const where = r.path ? ` ${r.path}` : "";
  const dup = e.duplicateOf ? ` same-call-as=${e.duplicateOf}` : "";
  return `[context-budget] ${e.id}  ${r.tool}${where}  step ${r.step}  ${r.tokens} tok archived; recall by id.${dup}`;
}

// A reducer applies to a result whatever its age: unlike a citation it is not a lossy summary
// of the result, it is the same list with the unranked tail folded to names. Returns null when
// no reducer matches the shape.
export function reduceResult(text: string, cfg: Config): string | null {
  if (!cfg.reduceSearch || !isToolSearch(text)) return null;
  return reduceToolSearch(text, cfg.searchKeepTop);
}
