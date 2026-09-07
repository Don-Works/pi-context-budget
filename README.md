# pi-context-budget

A [Pi](https://pi.dev) coding-agent extension that keeps a long session inside
the context window a model actually works well in. No LLM calls, nothing
paraphrased: the model's own text and the user's messages are never altered.
Anything removed from the prompt is snapshotted to an addressable archive the
model can recall exactly.

## Why

Pi's built-in compaction waits until the context passes
`contextWindow - reserveTokens`, then replaces everything except the most
recent `keepRecentTokens` with one LLM-written summary. Three things fill the
window long before that on a local or self-hosted model:

- **Thinking from earlier steps.** With an OpenAI-compatible endpoint Pi
  re-sends every earlier assistant step's `reasoning_content`, and a chat
  template that keeps it bills it on every request. In agentic sessions
  measured against a vLLM-served Qwen3 model this was about a third of the
  prompt.
- **Tool outputs the model has already reasoned about.** Shell output, file
  reads and search results stay verbatim forever.
- **Tool-call arguments.** The content of every `write`, the old and new text
  of every `edit`, every script passed to `bash` or `mcpx_exec` is re-sent as
  part of the assistant message that made the call.

Pi's own auto-compaction then fails on reasoning models: it asks the same
model to write a summary, thinking tokens count against `maxTokens`,
generation hits the cap, and you get `Summarization failed: generation hit
the token cap and the summary is incomplete`. The session keeps growing.

Replaying two recorded sessions through the planner at a 100k window:

| session | requests | peak prompt before | peak after | cumulative prefill | plan advances |
|---|---|---|---|---|---|
| 252-step tooling session | 252 | 321k | 100k | 49.7M → 14.7M | 140 |
| 197-step app session | 197 | 252k | 86k | 28.0M → 9.5M | 91 |

The default target is 60% of the window, so Pi's summarizer should rarely
need to run. If it does, this extension supplies a deterministic index
instead.

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
   to the archive under `th-<hash>`. The id is a hash of the text, so a
   compaction or branch switch that renumbers the steps changes nothing.
2. **Tool results** older than `keepRecentSteps` and larger than
   `minResultTokens` become a citation under `cb-<id>`: tool, step, size,
   head and tail of the original. A citation never keeps more than about 40%
   of a short result; errors always keep the configured tail, which is where
   compiler and stack-trace needles usually sit. A repeated call with the
   same tool and arguments marks the older citation as the same call as the
   later one.
3. **Tool-call arguments** older than `keepRecentSteps` and larger than
   `argMinTokens` are archived under `ca-<id>` and replaced inside the call
   with a one-line citation and a short head. The rest of the assistant
   message is untouched.
4. The **latest un-superseded `read` of each path** is kept verbatim within
   `protectLatestReadTokens`, so an edit does not force a re-read. A later
   `edit` or `write` of that path releases it; the snapshot still holds the
   file as of that step.
5. The **latest assistant step is never elided.** Its results are what the
   model is about to read.
6. The plan **only grows, and advances in batches**: when at least
   `batchTokens` can be elided, when `thinkBatchSteps` thinking blocks became
   eligible, or when anything is eligible above `highWaterFraction`. Between
   advances the serialized prefix is byte-identical, so a server prefix cache
   (vLLM `--enable-prefix-caching`, llama.cpp cache) keeps hitting. Nothing
   happens below `startAtFraction` of the window.

On by default:

7. **`interceptCompact`**: `session_before_compact` and `/tree` return a
   deterministic archive index instead of asking the session model to
   summarise. This is the fix for `generation hit the token cap and the
   summary is incomplete` on reasoning models.

Opt-in (default **false**):

8. **`squeeze`**: if the sent prompt is still above `targetFraction`, elide
   more, including recent and protected results, until it is at or below
   the cap. Measured against the exact citations that will be sent.
9. **`pin`**: a trailing `[context-budget pin]` for the session goal. Update
   with `context_budget_pin`.

The model recovers a snapshot with `context_budget_recall` (id from the
citation, or `list=true` for the catalog). Large snapshots page via
`offset` / `next_offset`. A short paragraph is appended to the system prompt
so the model knows what a citation means.

Snapshots live under `~/.pi/agent/context-budget/<sessionId>/` as 0600
files; plan state is persisted next to them so a Pi restart does not forget
the archive.

Not elided: user messages, assistant text, results that carry an image,
`!` shell output, and anything in the latest step.

## Install

```bash
pi install git:github.com/Don-Works/pi-context-budget@v0.3.0
```

or for one project: `pi install -l git:github.com/Don-Works/pi-context-budget@v0.3.0`.
It needs nothing beyond Pi itself; the tests and replay harness use Node 23+
for built-in TypeScript type stripping.

## Configure

Copy `context-budget.example.json` to `~/.pi/agent/context-budget.json` and
edit; every key is optional and the example holds the defaults.
`CONTEXT_BUDGET_CONFIG=<file>` points at a different file, `"enabled": false`
switches the extension off. Keys are checked by type; a mistyped value falls
back to the default.

| key | default | meaning |
|---|---|---|
| `startAtFraction` | 0.3 | do nothing below this fraction of the window |
| `highWaterFraction` | 0.6 | above this, advance as soon as anything is eligible |
| `interceptCompact` | true | replace Pi's LLM compaction with a deterministic archive index (false to use Pi's summarizer) |
| `squeeze` | false | if true, elide further until `targetFraction` |
| `pin` | false | if true, inject a trailing session-goal pin |
| `targetFraction` | 0.6 | squeeze target (only when `squeeze` is true) |
| `keepRecentSteps` | 8 | results and arguments younger than this many assistant steps are untouched (minimum 1) |
| `keepThinkingSteps` | 6 | thinking kept for this many most recent steps |
| `minResultTokens` | 300 | smaller results are never elided |
| `argMinTokens` | 150 | smaller tool-call arguments are never elided; 0 disables argument archiving |
| `batchTokens` | 6000 | advance only when this much can be elided at once |
| `thinkBatchSteps` | 4 | or when this many thinking blocks became eligible |
| `protectLatestReadTokens` | 12000 | budget for keeping the latest read per path |
| `stubHeadChars` | 400 | a result citation keeps up to this many leading chars |
| `stubTailChars` | 400 | …and up to this many trailing chars |
| `argHeadChars` | 160 | an argument citation keeps this many leading chars |
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
  target, the pin, the plan generation, archive counts by kind and the spill
  directory.
- The footer shows `ctx 48% −Nk gG` once something is elided (`G` is the plan
  generation; each increment moved the prefix-cache miss point once).
- `CONTEXT_BUDGET_LOG=<file>` appends one JSON line per request with
  `ctxBefore`, `ctxAfter`, `advanced`, `squeezed`, `resultsElided`,
  `argsElided`, `thinkingDropped` and the list of archived items.

## Replay a recorded session

```bash
node replay.ts ~/.pi/agent/sessions/<dir>/<session>.jsonl 100000
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
