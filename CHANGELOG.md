# Changelog

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
