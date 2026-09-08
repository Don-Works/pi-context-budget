// How much of a tool-search result is ever used? Reads recorded Pi sessions and, for each
// tool-search result, counts how many of the tools it listed were invoked later in the same
// session. This is the measurement behind `reduceSearch` and `searchKeepTop`: on the author's
// sessions the hit rate was 5.7%, so a citation that keeps the first and last two hits is
// spending its budget in the wrong place.
//
// It is also the before/after metric for narrowing a gateway's default result count: run it,
// change the default, run it again. A drop in "listed" with a flat "invoked" is the change
// working; "invoked" falling with it is the ranking, not the count, being the problem.
//
// usage: node search-hitrate.ts [sessionsDir] [minBytes]
//   node search-hitrate.ts ~/.pi/agent/sessions 50000
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.argv[2] ?? join(homedir(), ".pi", "agent", "sessions");
const minBytes = Number(process.argv[3] ?? 50_000);

// "- [0.69] ns__tool — description" (ranked) or "- ns__tool — description" (full detail).
const HIT = /^\s*-\s*(?:\[(\d+(?:\.\d+)?)\]\s*)?([A-Za-z0-9_]+__[A-Za-z0-9_]+)\s+—/gm;
const CHARS_PER_TOKEN = 3.3;

type Block = { type: string; text?: string; name?: string; id?: string; arguments?: Record<string, unknown> };
type Msg = { role: string; content?: Block[] | string; toolCallId?: string; toolName?: string };

function files(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (e.name.endsWith(".jsonl") && statSync(p).size >= minBytes) out.push(p);
  }
  return out;
}

const textOf = (m: Msg): string =>
  typeof m.content === "string" ? m.content : (m.content ?? []).map((b) => (b.type === "text" ? b.text ?? "" : "")).join("");

// The two ways a code-mode agent names a tool: mcpx_call({name}) and `ns.tool(...)` in a script.
function invokedBy(b: Block): Set<string> {
  const out = new Set<string>();
  const a = b.arguments ?? {};
  if (typeof a.name === "string") out.add(a.name);
  if (typeof a.code === "string") for (const m of a.code.matchAll(/\b([a-z0-9_]+)\.([a-z0-9_]+)\s*\(/g)) out.add(`${m[1]}__${m[2]}`);
  return out;
}

let searches = 0, listed = 0, invoked = 0, tokens = 0, namesOnlyTokens = 0, zeroUse = 0;
let repeats = 0, queries = 0;
const byRank = new Map<number, { n: number; used: number }>();

for (const file of files(root)) {
  const rows = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const msgs: Msg[] = rows.map((r) => r.message).filter(Boolean);
  const callById = new Map<string, Block>();
  for (const m of msgs) if (m.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) if (b.type === "toolCall" && b.id) callById.set(b.id, b);

  const calls: { at: number; names: Set<string> }[] = [];
  msgs.forEach((m, i) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (b.type !== "toolCall") continue;
      const names = invokedBy(b);
      if (names.size) calls.push({ at: i, names });
    }
  });

  const seenQueries = new Set<string>();
  msgs.forEach((m, i) => {
    if (m.role !== "toolResult") return;
    const call = callById.get(m.toolCallId ?? "");
    const text = textOf(m);
    if (!text.includes("## Results for ") || !HIT.test(text)) return;
    HIT.lastIndex = 0;

    const names = [...new Set([...text.matchAll(HIT)].map((x) => x[2]))];
    if (!names.length) return;
    const later = new Set<string>();
    for (const c of calls) if (c.at > i) for (const n of c.names) later.add(n);

    searches++;
    listed += names.length;
    tokens += Math.round(text.length / CHARS_PER_TOKEN);
    namesOnlyTokens += Math.round(names.join("\n").length / CHARS_PER_TOKEN);
    const used = names.filter((n) => later.has(n));
    invoked += used.length;
    if (!used.length) zeroUse++;

    // Rank within its own query block, which is what a page cap actually truncates.
    for (const block of text.split(/^## Results for /m).slice(1)) {
      let rank = 0;
      for (const hit of block.matchAll(HIT)) {
        rank++;
        const v = byRank.get(rank) ?? { n: 0, used: 0 };
        v.n++;
        if (later.has(hit[2])) v.used++;
        byRank.set(rank, v);
      }
    }

    const qs: string[] = [].concat((call?.arguments?.queries as never) ?? (call?.arguments?.query as never) ?? []);
    for (const q of qs) {
      queries++;
      if (seenQueries.has(q)) repeats++;
      else seenQueries.add(q);
    }
  });
}

if (!searches) {
  console.log(`no tool-search results found under ${root} (files >= ${minBytes} bytes)`);
  process.exit(0);
}
const pc = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`;
console.log(`tool-search results: ${searches}`);
console.log(`tools listed: ${listed}   later invoked: ${invoked}   hit rate: ${pc(invoked, listed)}`);
console.log(`searches where nothing listed was used: ${zeroUse} (${pc(zeroUse, searches)})`);
console.log(`result tokens: ${(tokens / 1000).toFixed(0)}k   names only would be ${(namesOnlyTokens / 1000).toFixed(0)}k (${pc(namesOnlyTokens, tokens)})`);
if (queries) console.log(`repeated queries within one session: ${repeats}/${queries} (${pc(repeats, queries)})`);
console.log("\nhit rate by rank within its query block:");
const ranks = [...byRank].sort((a, b) => a[0] - b[0]);
for (const [rank, v] of ranks.slice(0, 10)) console.log(`  #${String(rank).padEnd(3)} ${String(v.n).padStart(6)} listed ${String(v.used).padStart(5)} used ${pc(v.used, v.n).padStart(7)}`);
const tail = ranks.filter(([r]) => r > 6).reduce((a, [, v]) => ({ n: a.n + v.n, used: a.used + v.used }), { n: 0, used: 0 });
if (tail.n) console.log(`  7+   ${String(tail.n).padStart(6)} listed ${String(tail.used).padStart(5)} used ${pc(tail.used, tail.n).padStart(7)}`);
