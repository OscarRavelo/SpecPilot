# Step 9: mutation results

[Spec](step-9.md)

Stryker 10 over `src/cost.ts` and `src/mode.ts`, with the same settings `specpilot mutate` generates (Jest runner, TypeScript checker, `perTest` coverage). `specpilot mutate` itself needs a task under `specs/`, and SpecPilot's own steps have none. The CLI tests run `dist/cli.js`, so only the unit tests can kill these mutants.

| Run | Mutants | Compile errors | Killed | Timeout | Survived | No coverage | Score |
|---|---|---|---|---|---|---|---|
| Round 1 green (`402aa32`) | 361 | 110 | 178 | 5 | 58 | 10 | 72.9 % |
| Round 2 green (`61e8d31`) | 372 | 114 | 199 | 6 | 45 | 8 | 79.5 % |
| Round 3 tests (`2d6a3de`) | 372 | 114 | 213 | 12 | 29 | 4 | 87.2 % |
| Audit tests (`fa50a09`) | 372 | 114 | 219 | 9 | 26 | 4 | 88.4 % |

The round 2 pinning tests killed the survivors they targeted: `cost.ts` subagent folder name (`slice(0, -'.jsonl'.length)`) and missing transcript folder check; `mode.ts` unclosed frontmatter, its error message, CRLF line endings, the `^model:` anchor, the unchanged-file filter and saving the mode in `.specpilot/config.json`.

## Equivalent survivors

30 survivors, classified as equivalent and checked by an adversarial audit (below), pending the human's approval in the PR review. "Real logs" means the user's Claude Code transcripts in `~/.claude/projects/` on 2026-10-21 (5 main sessions, 64 subagent files) and their agent files.

| Location | Mutants | Why it is equivalent |
|---|---|---|
| `cost.ts:98` | 2 | A blank or whitespace-only line is dropped anyway: `JSON.parse` throws on it. Equivalent for every input. |
| `cost.ts:101` | 3 | Keeping primitives makes no difference (they have no `type` or `message`). Only a line that is exactly `null` differs, with a TypeError; real logs have 0 such lines. One of the three is equivalent for every input. |
| `cost.ts:115` | 7 | They count lines that are not assistant lines but carry an object `usage`, and some also count an assistant `usage` that is not an object (one mutant differs only on that). In real logs, every assistant `usage` is an object, the 63 other lines with `usage` are `attachment` lines with no `message` (skipped by every mutant), and `usage: null` never appears. |
| `cost.ts:118-121` | 4 (no coverage) | Fallbacks for `message.id`, `model`, `timestamp` and `sessionId`. The id, timestamp and session fallbacks are equivalent for every input; the model fallback only changes the text of the "No price" error. 0 of 2,916 real assistant lines lack any of these fields. |
| `cost.ts:136` | 1 | The list of commands starts with a string that can never match a `specpilot` command. Equivalent for every input. |
| `cost.ts:139`, `142`, `145` | 5 | They also read Bash calls from lines that are not assistant lines with array content, from any tool with an `input.command`, or `<bash-input>` from lines that are not user lines. In real logs, the `api-request-blob` lines (716 Bash `tool_use` blocks) repeat calls of the same session, 0 of 3,063 `tool_use` blocks are a non-Bash tool with `command`, and 0 non-user lines with string content hold `<bash-input>`. A PowerShell or MCP tool that takes `command` would break this. |
| `cost.ts:167`, `174` | 4 | Without `.sort()` the read order would matter for deduplication, but Node's `readdirSync` already returns names sorted on macOS and Linux, and session and subagent names are lowercase ASCII. Without the `.jsonl` filter, `subagents/` holds only `.jsonl` and `.meta.json` files in real logs (64 + 64, no folders), and no `.meta.json` holds `message` or `usage`. Equivalent on macOS and Linux only: Windows is not supported in v0.1 (see the [known limits](../known-limits.md#cost-and-modes)). |
| `cost.ts:240` | 1 | `typeof price[type] !== 'number'` replaced by `false`: `Number.isFinite` does not coerce, so it already rejects every value that is not a number. Equivalent for every input. |
| `cost.ts:270` | 1 | `latencyMs([])` is unreachable: `costReport` stops earlier when the window has no messages, and the package exposes only the CLI. |
| `mode.ts:49` | 1 | `/\r/` instead of `/\r$/` only differs for a `\r` inside a `---` line. 0 of the 3 real agent files hold any `\r`. |
| `mode.ts:70` | 1 | Without `.sort()`, agent files are processed in `readdirSync` order, which is already sorted on macOS and Linux. On Windows the order of the "updated" lines, and which file the error names when two are broken, could differ. Equivalent on macOS and Linux only: Windows is not supported in v0.1. |

## Audit of the equivalent survivors

A tests-agent session with no context from the earlier rounds tried to refute the 33 survivors classified as equivalent after round 3, using the real logs. It refuted 3, left 1 depending on the platform, and found the stated reason wrong or incomplete in 9 rows (corrected above):

| Mutant | Why it was not equivalent | Closed by |
|---|---|---|
| `cost.ts:139`, condition replaced by `true` | Real main transcripts hold lines with no `message` (6,058 of 9,370 lines: `attachment`, `permission-mode`, `ai-title`, …); the mutant iterates `undefined` and `cost` exits 1 with "is not iterable". | `AC-4: a task session whose transcript also holds lines without a message …` |
| `cost.ts:153`, escape replaced by `''` | Task ids may hold a dot (`fix-1.2`); the mutant looks for `fix-12` and finds no session. | `AC-4: a task id with a regex character (fix-1.2) …` |
| `mode.ts:23`, `', '` replaced by `''` | The error read `valid modes: standardmax`; the tests only checked that it contained both names. | `AC-15: an unknown mode prints exactly "Unknown mode: turbo (valid modes: standard, max)"` |

The human approved these three tests as an exception to the three-round limit, and all three mutants now die. `mode.ts:70` is equivalent only because Windows is not supported in v0.1.

## Real gaps closed in round 3

After round 2, 21 survivors were real gaps in files the user edits by hand. Round 3 added 27 tests for them, which pass against the current code; 20 of the 21 died, and the last one is the redundant `typeof` check listed above.

| Location | Survivors after round 2 | After round 3 | Case |
|---|---|---|---|
| `cost.ts:236-237` | 7 + 2 (no coverage) | 0 | A `prices.json` that is valid JSON but has no `models` object or no numeric `usdToEur`. |
| `cost.ts:240` | 4 | 1 (equivalent) | A model entry that is `null`, or a price too large to be finite (`1e999`). |
| `mode.ts:31`, `35` | 5 + 1 (no coverage) | 0 | A `.specpilot/config.json` that is `null`, an array or not JSON. |
| `mode.ts:67` | 1 + 1 (no coverage) | 0 | A project with no `.claude/agents/` folder. |

No real gap is left after the audit tests: the 30 remaining survivors are the equivalent ones listed above.
