// Archive ids, citations and exact slicing. Pure; shared by the planner and the extension.
import type { Config } from "./config.ts";

export type Kind = "result" | "thinking" | "arg";

export interface Elided {
  id: string;           // cb-<tail> (result), ca-<tail> (argument) or th-<hash> (thinking); used by the recall tool
  kind: Kind;
  path?: string;        // spill file, if the host wrote one
  step: number;
  tool: string;         // tool name, "thinking", or "<tool>(<argument>)"
  tokens: number;
  duplicateOf?: string; // archive id of a later call with the same tool and arguments, if any
}

export type Spill = (key: string, tool: string, step: number, text: string) => string | undefined;

// 48-bit content hash (cyrb53 variant); stable across compaction and branch switches.
export function hashText(str: string): string {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return ((h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0")).slice(0, 12);
}

function callTail(toolCallId: string): string {
  return toolCallId.replace(/[^A-Za-z0-9]/g, "").slice(-8) || "x";
}

export function archiveId(toolCallId: string): string {
  return `cb-${callTail(toolCallId)}`;
}

export function argId(toolCallId: string, ordinal = 0): string {
  return `ca-${callTail(toolCallId)}${ordinal > 0 ? `-${ordinal + 1}` : ""}`;
}

export function thinkId(hash: string): string {
  return `th-${hash}`;
}

export function thinkKey(text: string): string {
  return `think:${hashText(text)}`;
}

export function argKey(toolCallId: string, name: string): string {
  return `arg:${toolCallId}:${name}`;
}

export function sliceArchive(
  text: string,
  offset = 0,
  limit = 24000,
): { body: string; offset: number; next: number | null; total: number } {
  const o = Math.max(0, Math.min(offset, text.length));
  const n = Math.max(1, limit);
  const body = text.slice(o, o + n);
  const end = o + body.length;
  return { body, offset: o, next: end < text.length ? end : null, total: text.length };
}

export function formatCatalog(elided: Record<string, Elided>): string {
  const rows = Object.values(elided)
    .sort((a, b) => a.step - b.step || a.id.localeCompare(b.id))
    .map((e) => {
      const dup = e.duplicateOf ? ` same-call-as=${e.duplicateOf}` : "";
      const path = e.path ? ` ${e.path}` : "";
      return `${e.id}\t${e.tool}\tstep ${e.step}\t${e.tokens} tok${dup}${path}`;
    });
  return rows.length ? rows.join("\n") : "archive empty";
}

export function findElided(elided: Record<string, Elided>, id: string): Elided | undefined {
  if (elided[id]) return elided[id];
  return Object.values(elided).find((e) => e.id === id);
}

export function headTail(text: string, headChars: number, tailChars: number): { head: string; tail: string; omitted: number } {
  const headN = Math.max(0, headChars);
  const tailN = Math.max(0, tailChars);
  if (text.length <= headN + tailN) return { head: text, tail: "", omitted: 0 };
  return { head: text.slice(0, headN), tail: tailN ? text.slice(-tailN) : "", omitted: text.length - headN - tailN };
}

// A citation never keeps more than about 40% of a short result; errors always keep the configured tail.
export function stubWindow(chars: number, isError: boolean, cfg: Config): { head: number; tail: number } {
  const fifth = Math.floor(chars / 5);
  const head = Math.min(cfg.stubHeadChars, fifth);
  const tail = isError ? Math.min(cfg.stubTailChars, Math.max(0, chars - head)) : Math.min(cfg.stubTailChars, fifth);
  return { head, tail };
}

export interface CitationInfo {
  tool: string;
  step: number;
  tokens: number;
  path?: string;
  isError: boolean;
}

export function stubFor(r: CitationInfo, text: string, e: Elided, cfg: Config): string {
  const lines = text.split("\n").length;
  const win = stubWindow(text.length, r.isError, cfg);
  const { head, tail, omitted } = headTail(text, win.head, win.tail);
  const err = r.isError ? "  error" : "";
  const preview = omitted > 0
    ? `Head:\n${head}\n… ${omitted} chars omitted …\nTail:\n${tail}`
    : `Body:\n${head}`;
  const notes = [`Recall: context_budget_recall id=${e.id}.`];
  if (e.duplicateOf) notes.push(`Same call as later ${e.duplicateOf}; output may differ.`);
  if (r.tool === "read") notes.push(`File as of step ${r.step}; re-read ${r.path ?? "the path"} for current contents.`);
  if (!e.path) notes.push("Snapshot was not written; recall may be unavailable.");
  return `[context-budget] id=${e.id}  ${r.tool}${r.path ? " " + r.path : ""}  step ${r.step}  ${r.tokens} tokens  ${lines} lines${err}\n${preview}\n${notes.join(" ")}`;
}

export function argStub(text: string, e: Elided, cfg: Config): string {
  const head = text.slice(0, cfg.argHeadChars);
  const more = text.length > head.length ? "…" : "";
  return `[context-budget] id=${e.id}  ${text.length} chars archived. Head: ${head}${more} Recall: context_budget_recall id=${e.id}`;
}

export const RESULT_MIN_TOKENS_FLOOR = 80; // squeeze never elides anything smaller than this
