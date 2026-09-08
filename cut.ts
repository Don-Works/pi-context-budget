// Picking a compaction cut point when Pi's own frees nothing. Pure; no Pi imports.
//
// Pi's cut keeps keepRecentTokens of the tail. That setting is global, so a value chosen for a
// 262144-token model — or Pi's own default of 20000 — can exceed a small model's whole window, and
// then the cut lands at the head of the branch and the compaction discards almost nothing. Recut
// with a budget derived from the window instead, following Pi's rule for a valid cut: any
// context-visible message except a tool result, which has to stay with the call it answers.
import { estimate, type Config } from "./config.ts";
import { textOf, type Msg } from "./messages.ts";

export interface Entry {
  type?: string;
  id?: string;
  message?: Msg;
  firstKeptEntryId?: string; // compaction entries only
}

export interface Cut {
  id: string;
  index: number;
}

export function entryMessage(e: Entry | undefined): Msg | undefined {
  return e?.type === "message" && e.message ? e.message : undefined;
}

export function isCutPoint(e: Entry): boolean {
  const m = entryMessage(e);
  return !!m && m.role !== "toolResult";
}

export function indexOfEntry(entries: Entry[], id: string | undefined): number {
  const i = id ? entries.findIndex((e) => e.id === id) : -1;
  return i >= 0 ? i : 0;
}

// Start of the compactable span: what the last compaction kept, or the head of the branch.
export function boundaryStart(entries: Entry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type !== "compaction") continue;
    const kept = entries.findIndex((e) => e.id === entries[i].firstKeptEntryId);
    return kept >= 0 ? kept : i + 1;
  }
  return 0;
}

// Messages an entry range carries, in order.
export function spanMessages(entries: Entry[], fromIndex: number, toIndex: number): Msg[] {
  const out: Msg[] = [];
  for (let i = Math.max(0, fromIndex); i < Math.min(toIndex, entries.length); i++) {
    const m = entryMessage(entries[i]);
    if (m) out.push(m);
  }
  return out;
}

// Walk back from the newest entry until `keepTokens` is accumulated, then take the closest valid
// cut at or after it — Pi's own findCutPoint walk with a budget the window can hold. Only ever
// returns a cut later than `afterIndex`, so recutting always keeps less than Pi was going to.
export function recut(entries: Entry[], afterIndex: number, keepTokens: number, cfg: Config): Cut | undefined {
  let floor = afterIndex + 1;
  let acc = 0;
  for (let i = entries.length - 1; i > afterIndex; i--) {
    const m = entryMessage(entries[i]);
    if (!m) continue;
    acc += estimate(textOf(m), cfg) + 8;
    if (acc >= keepTokens) {
      floor = i;
      break;
    }
  }
  for (let i = Math.max(floor, afterIndex + 1); i < entries.length; i++) {
    const id = entries[i].id;
    if (id && isCutPoint(entries[i])) return { id, index: i };
  }
  return undefined;
}
