# pi-context-budget

A [Pi](https://pi.dev) coding-agent extension that keeps a long session inside
the context window a model actually works well in. No LLM calls, nothing
paraphrased: the model's own messages and the user's messages are never
altered, only what it has already consumed is trimmed.

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

Replaying a recorded 207k-token session through this planner cut the peak
prompt to about 65k tokens and cumulative prefill by 64%, with the plan
advancing 19 times across 123 requests.

## What it does

On every request (Pi's `context` hook, which sees a copy of the messages and
never touches the session file):

1. **Thinking** blocks of assistant steps older than `keepThinkingSteps` are
   dropped. Text and tool calls stay.
2. **Tool results** older than `keepRecentSteps` and larger than
   `minResultTokens` become a one-line stub naming the tool, step, size and
   first line, plus a spill file under `~/.pi/agent/context-budget/<sessionId>/`
   the model can `read` back if it needs the output again. `read` results get
   "re-read the file" instead of a spill; errors keep their first
   `errorHeadChars`.
3. The **latest un-superseded `read` of each path** is kept verbatim within
   `protectLatestReadTokens`, so an edit does not force a re-read. A later
   `edit` or `write` of that path releases it.
4. The plan **only grows, and advances in batches**: when at least
   `batchTokens` can be elided, when `thinkBatchSteps` thinking blocks became
   eligible, or when anything is eligible above `highWaterFraction`. Between
   advances the serialized prefix is byte-identical, so a server prefix cache
   (vLLM `--enable-prefix-caching`, llama.cpp cache) keeps hitting. Nothing
   happens below `startAtFraction` of the window.

A short paragraph is appended to the system prompt so the model knows what a
stub means. Pi's compaction still runs if a session outgrows the window; it
triggers on provider-reported usage, so pruning simply pushes it back.

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
| `keepRecentSteps` | 8 | tool results younger than this many assistant steps are untouched |
| `keepThinkingSteps` | 6 | thinking kept for this many most recent steps |
| `minResultTokens` | 600 | smaller results are never elided |
| `batchTokens` | 6000 | advance only when this much can be elided at once |
| `thinkBatchSteps` | 4 | or when this many thinking blocks became eligible |
| `protectLatestReadTokens` | 12000 | budget for keeping the latest read per path |
| `errorHeadChars` | 400 | error results keep this much of their head |
| `charsPerToken` | 3.3 | estimator used for thresholds |

`keepThinkingSteps` is the one knob with a measured quality trade-off:
published multi-turn tool-calling benchmarks give Qwen3-class models a few
points for retained thinking history, so keep it at 6 or above unless the
window is very small.

## Observe

- `/ctx` prints the provider-reported usage, what the last request elided,
  the plan generation and the spill directory.
- The footer shows `ctx −Nk gG` once something is elided (`G` is the plan
  generation; each increment re-prefilled the prefix once).
- `CONTEXT_BUDGET_LOG=<file>` appends one JSON line per request with
  `ctxBefore`, `ctxAfter`, `advanced`, `resultsElided`, `thinkingDropped` and
  the list of elided results.

## Replay a recorded session

```bash
node replay.ts ~/.pi/agent/sessions/<dir>/<session>.jsonl 131072
```

Runs the shipped planner request by request over the session's active branch
and prints peak and cumulative prompt tokens before and after, the number of
plan advances and two sample stubs.

## Test

```bash
npm test
```

## Alternatives

- [pi-dcp](https://github.com/PSU3D0/pi-dcp): heuristic like this one, does
  not handle thinking blocks.
- [pi-context-prune](https://github.com/championswimmer/pi-context-prune) and
  [pi-condense](https://github.com/jjuraszek/pi-condense): summarise finished
  tool batches with an LLM call, which is a second lossy step on the same
  model.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
