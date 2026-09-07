// Optional trailing session pin (goal + notes). Pure; no Pi imports.
import type { Config } from "./config.ts";
import { resultText, type Msg } from "./messages.ts";

export interface Scratch {
  goal: string;
  notes: string;
}

export function emptyScratch(): Scratch {
  return { goal: "", notes: "" };
}

export const PIN_PREFIX = "[context-budget pin]";

export function isPinMessage(m: Msg): boolean {
  if (m.role !== "user") return false;
  const t = typeof m.content === "string" ? m.content : resultText(m);
  return t.startsWith(PIN_PREFIX);
}

export function stripPin(messages: Msg[]): Msg[] {
  if (!messages.length || !isPinMessage(messages[messages.length - 1])) return messages;
  return messages.slice(0, -1);
}

export function firstUserText(messages: Msg[]): string {
  for (const m of messages) {
    if (m.role !== "user" || isPinMessage(m)) continue;
    const t = (typeof m.content === "string" ? m.content : resultText(m)).trim();
    if (t) return t;
  }
  return "";
}

export function seedScratch(scratch: Scratch, messages: Msg[], cfg: Config): boolean {
  if (scratch.goal) return false;
  const first = firstUserText(messages);
  if (!first) return false;
  scratch.goal = clip(first, Math.min(500, cfg.scratchLimitChars));
  return true;
}

export function setScratch(scratch: Scratch, patch: { goal?: string; notes?: string }, cfg: Config): { ok: boolean; error?: string } {
  const next: Scratch = {
    goal: patch.goal != null ? patch.goal.trim() : scratch.goal,
    notes: patch.notes != null ? patch.notes.trim() : scratch.notes,
  };
  const body = `${next.goal}\n${next.notes}`.trim();
  if (body.length > cfg.scratchLimitChars) {
    return { ok: false, error: `pin is ${body.length} chars; cap is ${cfg.scratchLimitChars}. Shorten goal or notes.` };
  }
  scratch.goal = next.goal;
  scratch.notes = next.notes;
  return { ok: true };
}

export function formatPin(scratch: Scratch): string | undefined {
  if (!scratch.goal && !scratch.notes) return undefined;
  const lines = [`${PIN_PREFIX} Session working memory (not a new request). Continue the task.`];
  if (scratch.goal) lines.push(`Goal: ${scratch.goal}`);
  if (scratch.notes) lines.push(`Notes:\n${scratch.notes}`);
  return lines.join("\n");
}

export function clip(text: string, n: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n - 1) + "…";
}
