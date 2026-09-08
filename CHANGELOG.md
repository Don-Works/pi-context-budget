# Changelog

## 0.6.0 — 2026-09-08

Every eligible result became a citation and then stayed one forever, so in a long session the
citations became the context. Measured over 36 recorded sessions of 60+ assistant steps: once
everything eligible is cited the prompt still carries 524k tokens of citations, plus 331k of
results under `minResultTokens` that were never elided at all — 65% of all results are under
that floor. The largest session's irreducible floor was 48.0k tokens: 37% of a 131072-token
window, 147% of a 32768-token one, which no amount of squeezing could fit.

A citation is also the wrong shape for a ranked list. On a tool-search result the head/tail
window spent its whole budget on the first two and last two hits and a fragment of the sandbox
type declarations; across 146 recorded searches, 3544 tools were listed and 203 were ever
invoked (5.7%), and hits at rank 6 or worse were used 4.0% of the time.

New

- A result now sits in one of three tiers, and only ever moves downwards, so the plan keeps its
  "only ever grows" property and the prompt cannot thrash between forms:
  - `reduced` — a projection of the result's own structure. For a tool search: the top
    `searchKeepTop` (3) hits of each query block with their descriptions, the rest listed by
    name after `also:`, and the `## Code API` signature dump dropped. Unlike a citation this is
    the same list rather than a summary of it, so it does not wait for `keepRecentSteps` — one
    step of age is enough. The latest assistant step is still never touched.
  - `cite` — the head/tail citation, unchanged, and still the default for unstructured output.
  - `lean` — one index line (`[context-budget] cb-… bash step 41 1243 tok archived; recall by
    id.`) once a result is `leanAfterSteps` (24) old and nothing has recalled it. The tool call
    it answers is still beside it in the prompt, which for a shell result is the command itself.
- `leanAfterSteps` also dissolves the `minResultTokens` floor for old results: a ~20-token index
  line pays for itself on a 250-token result, which a ~290-token citation never did. Results
  above `leanMinTokens` (60) are leaned whether or not they were ever citation-eligible.
- A result the model passed to `context_budget_recall` keeps its citation and is never leaned:
  asking for the snapshot back is the model saying it still wants that content.
- `squeeze` demotes old un-recalled citations to lean lines before it elides anything recent,
  which is a cheaper first move than the one it used to make.
- `/ctx` and the replay harness report the three tiers separately.
  `CONTEXT_BUDGET_REPLAY_CFG` overrides any config key, so one recorded session can be replayed
  under two settings and the difference read off directly.

Replaying recorded sessions through the planner, 0.5.0 → 0.6.0:

| session | window | peak context | cumulative prefill | plan advances |
|---|---|---|---|---|
| 288 requests | 131072 | 86202 → 57154 | 13.6M → 10.0M | 47 → 37 |
| 324 requests | 131072 | 120981 → 81473 | 21.2M → 14.9M | 108 → 39 |
| 252 requests | 131072 | 90415 → 60472 | 13.9M → 10.1M | 90 → 41 |
| 288 requests | 32768 | 76704 → 47900 | 9.8M → 6.1M | 246 → 220 |
| 128 requests | 32768 | 38006 → 27011 | 2.6M → 1.8M | 116 → 86 |

Fewer advances is the second effect: leaning frees enough that the plan has to move the
prefix-cache miss point less often to stay under the same cap.

Upgrade

- `state.json` from 0.5.0 loads as-is; an entry with no tier reads as `cite`, and an unknown
  tier is not trusted. The tier is persisted, because losing it across a Pi restart would read a
  lean entry back as a citation — a promotion, the one direction the tiers must never move.
- `leanAfterSteps: 0` disables the lean tier, `reduceSearch: false` the reducer; together they
  restore 0.5.0 behaviour exactly.

## 0.5.0 — 2026-09-08

An editing session's largest re-sent content was never archived, and what the
archive did replace it with did not say what the call had done. Measured on a
326-request session that built a Swift MCP server: 312 thinking snapshots and 13
`write.content` snapshots were taken, and not one `edit` payload — the tool made
41 edits to one 40KB file, every one of them still in the prompt.

Fixes

- Large strings nested inside a tool call's arguments are archived, not only
  top-level ones. Pi's `edit` passes `edits: [{oldText, newText}]`; walking only
  the top level meant the case the README names as motivating the feature was
  the one case it never covered. Collection walks arrays and plain objects to a
  bounded depth, and the stub is written back into the nested position, leaving
  the surrounding structure — and the identity of every untouched branch — intact.
- An archived argument now names its call and the file it touched, the way a
  result citation always has: `id=ca-…  edit(edits[0].newText) /path/to/file
  step 12  4389 chars archived. Head: …`. It used to read `id=ca-…  269 chars
  archived. Head: …`, which in a compacted transcript left the model no way to
  tell what the call did or which file it wrote — enough, in one observed
  session, for an agent to stop recognising its own writes as its own and report
  that another process had replaced its work.

Replaying that session at a 131072-token window: peak context after the plan
713005 → 695668, the final request 31174 → 26409, and 225 → 175 plan advances,
so the prefix-cache miss point moves 50 fewer times.

## 0.4.0 — 2026-09-08

Pi's compaction settings are global — one `reserveTokens` and one
`keepRecentTokens` for every model — so a pair chosen for a large window can make
compaction impossible on a small one. Observed on a 32768-token model with
`reserveTokens: 16384` and `keepRecentTokens: 32000`: Pi compacts above 16384,
its cut keeps more than the window holds, so each compaction dropped about ten
of 136 entries and the next request compacted again — three in 117 seconds.

Fixes

- The plan reads Pi's compaction block (a project `.pi/settings.json` merged over
  the global file) and resolves its budget against the resulting threshold. Where
  the configured `targetFraction` already sits below it — every window where
  `reserveTokens` is a small share of the total — the configured values are used
  unchanged. Where it sits above, the cap is pulled under the threshold and
  `squeeze` is turned on, because a target the plan will not enforce leaves Pi
  compacting on every request.
- A compaction whose cut would free less than the compaction has to free is recut
  to a cut point sized to the window, chosen by Pi's own rule: any context-visible
  message except a tool result.
- A threshold compaction that still cannot get under the threshold is cancelled
  instead of writing an index entry every turn, with one warning naming the two
  settings to change. Manual and overflow compactions always run — overflow is
  the turn that already failed for size.
- The compaction index keeps the session goal, reading it from the previous
  summary. Every compaction after the first said "(not captured)".
- `~/.pi/agent` is resolved through `PI_CODING_AGENT_DIR`, as Pi resolves it.

New

- `/ctx` prints the resolved cap, Pi's compaction threshold and whether the cap
  was clamped. `CONTEXT_BUDGET_LOG` lines carry `cap`, `trigger` and `clamped`.
- `replay.ts` takes the Pi reserve and the system-prompt size, and reports the
  budget it resolved, so a recorded session can be replayed against the threshold
  it would really meet.

## 0.3.0 — 2026-09-07

Fixes

- Thinking snapshots are keyed by content (`th-<hash>`), not by step position. In 0.2.0 any compaction
  or branch switch shifted the step numbers, so every remaining step's thinking was dropped from the
  prompt and, because the positional key already existed, never archived.
- The latest assistant step is never elided: its results are what the model is about to read.
  `keepRecentSteps` is clamped to at least 1 and the opt-in squeeze no longer reaches it.
- Tool results that carry an image block are never elided (the archive holds text only).
- Squeeze measures savings against the citation it will actually send, so `targetFraction` is a real cap.
- Estimates count compaction and branch summaries, `!` shell output and the system prompt.
- The `/tree` summary hook no longer reads a field Pi does not provide.
- "Exact duplicate" became "same call as later …; output may differ" — the earlier wording claimed
  identical output for identical arguments.
- Spill filenames no longer contain `:`.

New

- Large string arguments of older tool calls (`write` content, `edit` text, `bash` scripts,
  `mcpx_exec` code) are archived under `ca-<id>` and replaced in the call with a short citation.
  `argMinTokens` (default 150) sets the floor; 0 disables.
- Citations are shorter: no spill path, one-line notes, and a citation never keeps more than about
  40% of a short result. `minResultTokens` default drops from 600 to 300.
- `/ctx` reports results, arguments and thinking separately.

Upgrade

- `state.json` from 0.2.0 loads as-is; old `th-<step>` entries stay recallable, and the first
  request after upgrading re-archives old thinking under content ids (one extra plan advance).
- Config keys are validated by type; unknown keys are ignored and `errorHeadChars` still maps to
  `stubHeadChars`.

## 0.2.0 — 2026-09-07

Addressable archive: every elided result is snapshotted, thinking is archived under `th-<step>`,
citations carry head and tail, `context_budget_recall` pages large snapshots, state persists.

## 0.1.0 — 2026-09-07

Initial release: prune old thinking and stale tool outputs in Pi sessions.
