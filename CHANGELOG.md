# Changelog

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
