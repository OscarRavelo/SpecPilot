# Cost, latency and modes

[← Back to the README](../README.md)

## `specpilot cost <task>`

Reports the tokens, cost and latency of one task from the Claude Code transcripts of the current project:

```
TASK-101 (in progress)
Tokens: input 1,234, output 567, cache read 89,012, cache write 3,456
Cost: 0.09 USD, 0.08 EUR
Latency: 1m 02s
Mode: standard
Prices: /path/to/prices.json (checked 2026-10-20)
```

With `--json` it prints the same data as one JSON object: `taskId`, `inProgress`, `tokens` (`input`, `output`, `cacheRead`, `cacheWrite`), `usd`, `eur`, `latencyMs`, `mode` and `prices` (`file`, `checked`).

How it finds the task's messages:

- **Transcript folder:** `~/.claude/projects/<P>`, where `<P>` is the absolute project path with every character that is not a letter or a digit replaced by `-`. Only this folder is read. If it does not exist, `cost` exits 1 naming it.
- **Task sessions:** a session belongs to the task if its main transcript runs a `specpilot` command naming the task (`gate`, `tdd red|green`, `mutate`, `mutate bug`, `verify` or `reopen`), as a Bash tool call or a `!` command. Its subagent transcripts (`<session>/subagents/*.jsonl`) and sidechain entries count too.
- **Window:** from the first to the last `at` in the task's `state.json` history, both included. A task not yet in `done` has a window that ends now, and the report says `in progress`.
- **Messages:** assistant entries with `usage`, counted once per `message.id`. Entries of model `<synthetic>` are skipped.
- **Latency:** from the first to the last counted message.

Errors exit 1 with one line and print no cost: no transcript folder, a task with no transitions, no counted message in the window (`<task> has no messages in its window`), or a model with no price (`No price for model <id> in <file>`). A missing price is never counted as 0.

## `prices.json`

USD per million tokens per model and token type, a USD→EUR rate and the date the prices were checked:

```json
{
  "checked": "2026-10-20",
  "usdToEur": 0.8917,
  "models": {
    "claude-opus-5-5": { "input": 4, "output": 20, "cacheRead": 0.2, "cacheWrite": 5 }
  }
}
```

The defaults ship in [`templates/prices.json`](../templates/prices.json): `claude-fable-5-1`, `claude-opus-5-5` and `claude-sonnet-5-5`, from the [Anthropic pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-20 (`cacheWrite` is the 5-minute cache write price). `usdToEur` is 1 / 1.1215, the [ECB reference rate](https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/eurofxref-graph-usd.en.html) of the same day. A `.specpilot/prices.json` in the project replaces the defaults whole.

Cost is computed per model with no rounding and summed. The USD total is then rounded to cents, and EUR is the unrounded USD total times `usdToEur`, also rounded once.

## `specpilot mode [standard|max]`

Sets the `model:` line in the frontmatter of every `.claude/agents/*.md` and saves the mode in `.specpilot/config.json`. With no argument it prints the current mode; the default is `standard`.

| Mode | Default model | Why |
|---|---|---|
| `standard` | `sonnet` | Half the price of Opus per token; Anthropic's "best combination of speed and intelligence" |
| `max` | `opus` | The most capable model a Claude Code alias reaches |

`.specpilot/config.json` can override the models: `{"modes": {"standard": "...", "max": "..."}}`. Only the `model:` line changes (a frontmatter without one gets it added before the closing `---`), and running the same mode twice changes nothing. An unknown mode, or any agent file with no frontmatter, is an error and no file changes.

See the [known limits](known-limits.md#cost-and-modes).
