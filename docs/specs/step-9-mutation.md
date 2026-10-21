# Step 9: mutation results

[Spec](step-9.md)

Stryker 10 over `src/cost.ts` and `src/mode.ts`, with the same settings `specpilot mutate` generates (Jest runner, TypeScript checker, `perTest` coverage). `specpilot mutate` itself needs a task under `specs/`, and SpecPilot's own steps have none. The CLI tests run `dist/cli.js`, so only the unit tests can kill these mutants.

| Run | Mutants | Compile errors | Killed | Timeout | Survived | No coverage | Score |
|---|---|---|---|---|---|---|---|
| Round 1 green (`402aa32`) | 361 | 110 | 178 | 5 | 58 | 10 | 72.9 % |
| Round 2 green (`61e8d31`) | 372 | 114 | 199 | 6 | 45 | 8 | 79.5 % |

The round 2 pinning tests killed the survivors they targeted: `cost.ts` subagent folder name (`slice(0, -'.jsonl'.length)`) and missing transcript folder check; `mode.ts` unclosed frontmatter, its error message, CRLF line endings, the `^model:` anchor, the unchanged-file filter and saving the mode in `.specpilot/config.json`.

## Equivalent survivors

Classified as equivalent in the round 2 review, pending the human's approval in the PR review: no input SpecPilot reads, or no transcript Claude Code writes, tells them apart from the original code.

| Location | Mutants | Why it is equivalent |
|---|---|---|
| `cost.ts:98` | 2 | A blank line is skipped anyway: `JSON.parse` throws on it and the line is dropped. |
| `cost.ts:101` | 3 | Only JSON lines that are not objects (`null`, a number) differ. Claude Code writes only objects. |
| `cost.ts:115` | 7 | Only non-assistant lines with `usage`, or `usage: null`, differ. Claude Code writes `usage` only on assistant messages. |
| `cost.ts:118-121` | 4 (no coverage) | Fallbacks for `message.id`, `model`, `timestamp` and `sessionId`, which Claude Code always writes. |
| `cost.ts:136` | 1 | The initial list of commands starts with a string that can never match a `specpilot` command. |
| `cost.ts:139`, `142`, `145` | 6 | Only content shapes Claude Code does not write differ: tool calls in user lines, `<bash-input>` in assistant lines, a non-Bash tool with an `input.command`. |
| `cost.ts:153` | 1 | Only a task id with regex characters differs, and task ids are folder names such as `TASK-1`. |
| `cost.ts:167` | 1 | Removing `.sort()` changes the order sessions are read in, not the totals. |
| `cost.ts:174` | 3 | Removing the `.jsonl` filter also reads `subagents/*.meta.json`, which hold no assistant lines; removing `.sort()` changes no total. |
| `cost.ts:270` | 1 | `latencyMs([])` is unreachable: `costReport` stops earlier when the window has no messages. |
| `mode.ts:23` | 1 | The separator in the list of valid modes; the message still names `standard` and `max`. |
| `mode.ts:49` | 1 | `/\r/` instead of `/\r$/` only differs for a `\r` inside a `---` line. |
| `mode.ts:70` | 1 | Removing `.sort()` writes the same files. |

## Survivors that are real gaps

These are files the user can edit by hand. They are not equivalent; they are left for round 3 or the known limits.

| Location | Mutants | Gap |
|---|---|---|
| `cost.ts:236-237` | 7 + 2 (no coverage) | No test for a `prices.json` that is valid JSON but has no `models` object or no numeric `usdToEur`. |
| `cost.ts:240` | 4 | No test for a model entry that is `null`, or a price too large to be finite (`1e999`). |
| `mode.ts:31`, `35` | 5 + 1 (no coverage) | No test for a `.specpilot/config.json` that is `null`, an array or not JSON. |
| `mode.ts:67` | 1 + 1 (no coverage) | No test for a project with no `.claude/agents/` folder. |
