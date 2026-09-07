# pi-context-budget

A [Pi](https://pi.dev) coding-agent extension that keeps a long session inside
the context window a model actually works well in. No LLM calls, nothing
paraphrased: the model's own messages and the user's messages are never
altered. Anything removed from the prompt is snapshotted to an addressable
archive the model can recall exactly.

## Why

Pi's built-in compaction waits until the context passes
`contextWindow - reserveTokens`, then replaces everything except the most
recent `keepRecentTokens` with one LLM-written summary. Two things fill the
window long before that on a local or self-hosted model:

- **Thinking from earlier steps.** With an OpenAI-compatible endpoint Pi
  re-sends every earlier assistant step's `reasoning_content`, and a chat
  template that keeps it bills it on every request. In agentic sessions
  measured against a vLLM-served Qwen3 model this was about a third of the
  prompt.
- **Tool outputs the model has already reasoned about.** Shell output, file
  reads and search results stay verbatim forever.
- **Pi's own auto-compaction then fails on reasoning models.** It asks the
  same model to write a summary; thinking tokens count against `maxTokens`,
  generation hits the cap, and you get `Summarization failed: generation hit
  the token cap and the summary is incomplete`. The session keeps growing.

Replaying a recorded 207k-token session through this planner cut the peak
prompt to about 65k tokens and cumulative prefill by 64%, with the plan
advancing 19 times across 123 requests. The default target is now 60% of the
window, so Pi's summarizer should not need to run. If it does, this extension
supplies a deterministic index instead.

Lossless here means *recoverable*, not *still in the prompt*. 2026 work on
addressable recall (ARC), VISTA, and structurally lossless trimming all make
the same split: keep a bounded active view, keep every original in an
append-only store, recover by id rather than by re-running the tool or by
embedding search. Re-running is not lossless (`git status`, logs, and files
change). Summarising is not lossless (the paraphrase cannot be inverted).

## What it does

On every request (Pi's `context` hook, which sees a copy of the messages and
never touches the session file):

1. **Thinking** blocks of assistant steps older than `keepThinkingSteps` are
   dropped from the prompt (they would be re-billed every turn) and written
   to the archive under `th-<step>`.
2. **Tool results** older than `keepRecentSteps` and larger than
   `minResultTokens` become a citation: archive id, tool, step, size, head
   and tail of the original, plus a spill file under
   `~/.pi/agent/context-budget/<sessionId>/`. Errors keep the tail as well as
   the head, which is where compiler and stack-trace needles usually sit.
   Repeated calls with the same tool and arguments mark the older citation as
   a duplicate of the later one.
3. The **latest un-superseded `read` of each path** is kept verbatim within
   `protectLatestReadTokens`, so an edit does not force a re-read. A later
   `edit` or `write` of that path releases it; the snapshot still holds the
   file as of that step. Re-read the path only if you want the current disk
   contents.
4. The plan **only grows, and advances in batches**: when at least
   `batchTokens` can be elided, when `thinkBatchSteps` thinking blocks became
   eligible, or when anything is eligible above `highWaterFraction`. Between
   advances the serialized prefix is byte-identical, so a server prefix cache
   (vLLM `--enable-prefix-caching`, llama.cpp cache) keeps hitting. Nothing
   happens below `startAtFraction` of the window.
Opt-in (all default **false**):

5. **`squeeze`**: if the sent prompt is still above `targetFraction`, elide
   more until it is at or below the cap.
6. **`pin`**: a trailing `[context-budget pin]` for the session goal. Update
   with `context_budget_pin`.
7. **`interceptCompact`** (on by default): `session_before_compact` / `/tree`
   return a deterministic archive index instead of asking the session model
   to summarise. This is the fix for `generation hit the token cap and the
   summary is incomplete` on reasoning models.

The model recovers a snapshot with `context_budget_recall` (id from the
citation, or `list=true` for the catalog). Large snapshots page via
`offset` / `next_offset`. A short paragraph is appended to the system prompt
so the model knows what a citation means.

Plan state is persisted next to the spill files so a Pi restart does not
forget the archive.

## Install

```bash
pi install git:github.com/Don-Works/pi-context-budget
```

or for one project: `pi install -l git:github.com/Don-Works/pi-context-budget`.
It needs nothing beyond Pi itself; the tests and replay harness use Node 23+
for built-in TypeScript type stripping.

## Configure

Copy `context-budget.example.json` to `~/.pi/agent/context-budget.json` and
edit; every key is optional and the example holds the defaults.
`CONTEXT_BUDGET_CONFIG=<file>` points at a different file, `"enabled": false`
switches the extension off.

| key | default | meaning |
|---|---|---|
| `startAtFraction` | 0.3 | do nothing below this fraction of the window |
| `highWaterFraction` | 0.6 | above this, advance as soon as anything is eligible |
| `squeeze` | false | if true, elide further until `targetFraction` |
| `pin` | false | if true, inject a trailing session-goal pin |
| `interceptCompact` | true | replace Pi's LLM compaction with a deterministic archive index (set false to use Pi's summarizer) |
| `targetFraction` | 0.6 | squeeze target (only when `squeeze` is true) |
| `keepRecentSteps` | 8 | tool results younger than this many assistant steps are untouched |
| `keepThinkingSteps` | 6 | thinking kept for this many most recent steps |
| `minResultTokens` | 600 | smaller results are never elided |
| `batchTokens` | 6000 | advance only when this much can be elided at once |
| `thinkBatchSteps` | 4 | or when this many thinking blocks became eligible |
| `protectLatestReadTokens` | 12000 | budget for keeping the latest read per path |
| `stubHeadChars` | 400 | citation keeps this many leading chars of the original |
| `stubTailChars` | 400 | …and this many trailing chars |
| `recallLimitChars` | 24000 | default chunk size for `context_budget_recall` |
| `emergencyKeepSteps` | 2 | squeeze tries to keep this many recent result steps |
| `emergencyKeepThinking` | 1 | squeeze drops thinking to this many recent steps |
| `scratchLimitChars` | 1500 | hard cap for the session pin |
| `charsPerToken` | 3.3 | estimator used for thresholds |

`keepThinkingSteps` is the one knob with a measured quality trade-off:
published multi-turn tool-calling benchmarks give Qwen3-class models a few
points for retained thinking history, so keep it at 6 or above unless the
window is very small. Dropped thinking is still in the archive.

An older `errorHeadChars` key is still read as `stubHeadChars`.

## Observe

- `/ctx` prints the provider-reported usage, plugin-sent estimate vs the 60%
  target, the pin, the plan generation, archive size and the spill directory.
- The footer shows `ctx 48% −Nk gG` once something is elided (`G` is the plan
  generation; each increment re-prefilled the prefix once).
- `CONTEXT_BUDGET_LOG=<file>` appends one JSON line per request with
  `ctxBefore`, `ctxAfter`, `advanced`, `squeezed`, `resultsElided`,
  `thinkingDropped` and the list of archived items.

## Replay a recorded session

```bash
node replay.ts ~/.pi/agent/sessions/<dir>/<session>.jsonl 131072
```

Runs the shipped planner request by request over the session's active branch
and prints peak and cumulative prompt tokens before and after, the number of
plan advances and two sample citations.

## Test

```bash
npm test
```

## Alternatives

- [pi-dcp](https://github.com/PSU3D0/pi-dcp): heuristic like this one, does
  not handle thinking blocks or archive snapshots.
- [pi-context-prune](https://github.com/championswimmer/pi-context-prune) and
  [pi-condense](https://github.com/jjuraszek/pi-condense): summarise finished
  tool batches with an LLM call, which is a second lossy step on the same
  model.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
