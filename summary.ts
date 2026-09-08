// Deterministic compaction index: what Pi gets instead of an LLM-written summary. Pure.
import type { Config } from "./config.ts";
import type { Elided } from "./archive.ts";
import { resultText, type Msg } from "./messages.ts";
import { clip, isPinMessage, type Scratch } from "./pin.ts";

export interface CompactInput {
  messagesToSummarize?: Msg[];
  turnPrefixMessages?: Msg[];
  previousSummary?: string;
  fileOps?: { read?: Iterable<string>; edited?: Iterable<string>; written?: Iterable<string> };
  tokensBefore?: number;
  customInstructions?: string;
}

export interface SummaryState {
  elided: Record<string, Elided>;
  gen: number;
  scratch: Scratch;
}

const CAP = 8000;
const MAX_ROWS = 40;

export function deterministicSummary(input: CompactInput, state: SummaryState, _cfg: Config): string {
  const users = userAsks(input);
  const { read, modified } = fileLists(input.fileOps);
  const archived = Object.values(state.elided).sort((a, b) => a.step - b.step || a.id.localeCompare(b.id));
  const toolRows = archived.filter((e) => e.kind !== "thinking");
  const thinkN = archived.length - toolRows.length;
  const goal = state.scratch.goal || goalOf(input.previousSummary) || users[0] || "(not captured)";
  const lines: string[] = [
    "## Goal", goal, "",
    "## Constraints & Preferences", state.scratch.notes || "- (none pinned)", "",
    "## Progress",
    `- Context-budget archive: ${toolRows.length} tool snapshots, ${thinkN} thinking snapshots, plan generation ${state.gen}.`,
    "- Originals are on disk; recall with context_budget_recall id=<cb-…, ca-… or th-…>. Do not re-run tools for historical output.",
    "",
    "## User asks in the compacted span",
    ...(users.length ? users.map((u) => `- ${u}`) : ["- (none)"]),
    "",
    "## Key Decisions",
    "- Compaction is lossless at the archive: this summary is an index, not a paraphrase of tool output.",
    "",
    "## Next Steps",
    "1. Continue from the kept recent messages after this summary.",
    "2. Recall an archive id if a compacted tool result is needed verbatim.",
    "",
    "## Critical Context",
    `- tokensBefore ${input.tokensBefore ?? "?"}`,
    input.previousSummary ? `- Previous compaction summary (head): ${clip(input.previousSummary, 600)}` : "- No previous compaction summary.",
  ];
  if (input.customInstructions) lines.push(`- Custom instructions: ${clip(input.customInstructions, 300)}`);
  lines.push(...archiveSection(toolRows), ...fileSection("read-files", read), ...fileSection("modified-files", modified));
  const text = lines.join("\n");
  return text.length <= CAP ? text : text.slice(0, CAP) + "\n… (index truncated)";
}

// After the first compaction the opening ask is no longer in the span being summarized, only in
// the summary that compaction wrote. Without this every later index says "(not captured)".
function goalOf(previous: string | undefined): string {
  const goal = previous ? (/^## Goal\n(.+)$/m.exec(previous)?.[1] ?? "").trim() : "";
  return goal === "(not captured)" ? "" : goal;
}

function userAsks(input: CompactInput): string[] {
  return [...(input.messagesToSummarize ?? []), ...(input.turnPrefixMessages ?? [])]
    .filter((m) => m.role === "user" && !isPinMessage(m))
    .map((m) => clip(typeof m.content === "string" ? m.content : resultText(m), 400))
    .filter(Boolean)
    .slice(0, 8);
}

function archiveSection(rows: Elided[]): string[] {
  if (!rows.length) return [];
  const out = ["", "## Archive"];
  for (const e of rows.slice(0, MAX_ROWS)) out.push(`- ${e.id}  ${e.tool}  step ${e.step}  ${e.tokens} tok`);
  if (rows.length > MAX_ROWS) out.push(`- … ${rows.length - MAX_ROWS} more; context_budget_recall list=true`);
  return out;
}

function fileSection(tag: string, paths: string[]): string[] {
  if (!paths.length) return [];
  return ["", `<${tag}>`, ...paths.slice(0, MAX_ROWS), `</${tag}>`];
}

function fileLists(fileOps: CompactInput["fileOps"]): { read: string[]; modified: string[] } {
  if (!fileOps) return { read: [], modified: [] };
  const asArr = (v?: Iterable<string>) => (v ? [...v] : []);
  const modified = unique([...asArr(fileOps.edited), ...asArr(fileOps.written)]);
  const read = unique(asArr(fileOps.read)).filter((p) => !modified.includes(p));
  return { read, modified };
}

function unique(xs: string[]): string[] {
  return [...new Set(xs.filter(Boolean))];
}
