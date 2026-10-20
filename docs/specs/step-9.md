---
id: step-9
type: cli-command
---
# Per-task cost and latency metrics, Standard/Max modes (roadmap step 9)

`specpilot cost <taskId>` reads the Claude Code transcripts of the current project and reports the tokens, cost and latency of one task. `specpilot mode standard|max` sets the model of every project agent.

## Definitions

- **Transcript folder**: `~/.claude/projects/<P>`, where `<P>` is the absolute project path with every character that is not a letter or a digit replaced by `-` (`/Users/me/my.app` → `-Users-me-my-app`). Home is `os.homedir()`.
- **Transcript files**: `<session>.jsonl` in that folder, and `<session>/subagents/*.jsonl` for that session's subagents (their lines have `isSidechain: true` and the parent `sessionId`).
- **Counted message**: a line with `type: "assistant"` and `message.usage`, whose `message.model` is not `<synthetic>`. Token types: `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`.
- **Task session**: a session whose main transcript runs a `specpilot` command naming the task (`gate`, `tdd red|green`, `mutate`, `mutate bug`, `verify` or `reopen` followed by `<taskId>`), either as a Bash tool call or as a `!` command. Its subagent files belong to it.
- **Task window**: from the `at` of the first entry in `specs/<taskId>/state.json` `history` to the `at` of the last one, both included. If the task is not in `done`, the window ends now and the task is "in progress".
- **prices.json**: `{"checked": "YYYY-MM-DD", "usdToEur": <number>, "models": {"<model id>": {"input", "output", "cacheRead", "cacheWrite"}}}`, USD per million tokens. Defaults ship with SpecPilot; `.specpilot/prices.json` in the project replaces them whole.
- **Mode config**: defaults `standard` → `sonnet`, `max` → `opus`; `.specpilot/config.json` (`{"mode": ..., "modes": {"standard": ..., "max": ...}}`) overrides them.

## Acceptance criteria

### AC-1: Totals each token type exactly
- Given task TASK-1 with a window that holds 2 counted messages of model claude-sonnet-5-5
- And their usage is input 100/200, output 10/20, cache read 1000/2000, cache write 50/60
- When I run specpilot cost TASK-1 --json
- Then tokens is {"input": 300, "output": 30, "cacheRead": 3000, "cacheWrite": 110}

### AC-2: Counts a repeated message.id once
- Given the transcript holds message msg_1 three times with input 100 each
- And one other message msg_2 with input 7
- When I run specpilot cost TASK-1 --json
- Then tokens.input is 107

### AC-3: Includes subagent messages of the task session
- Given the task session's main transcript has a message with output 10
- And a sidechain line in the same file has output 20
- And the file <session>/subagents/agent-x.jsonl has a message with output 40 inside the window
- When I run specpilot cost TASK-1 --json
- Then tokens.output is 70

### AC-4: Counts only messages of the task's sessions inside its window
- Given TASK-1 history runs from 2026-01-01T10:00:00.000Z to 2026-01-01T11:00:00.000Z and the task is done
- And the task session has messages at 09:59:59, 10:00:00, 10:30:00, 11:00:00 and 11:00:01 with input 1, 2, 4, 8 and 16
- And another session of the same project, which never runs a specpilot command for TASK-1, has a message at 10:30:00 with input 32
- When I run specpilot cost TASK-1 --json
- Then tokens.input is 14

### AC-5: An unfinished task's window ends now
- Given TASK-1 is in green with a first transition at 2026-01-01T10:00:00.000Z
- And the task session has a message after the last transition with input 5
- When I run specpilot cost TASK-1
- Then the message is counted
- And the output says TASK-1 is in progress
- And with --json, inProgress is true

### AC-6: Reads only the current project's transcript folder
- Given transcripts for TASK-1 exist only under the folder of another project path
- When I run specpilot cost TASK-1
- Then they are not read
- And when the current project's folder does not exist, the command exits 1 with one line naming the missing folder

### AC-7: Prices come from prices.json, with shipped defaults and a project override
- Given no .specpilot/prices.json in the project
- When I run specpilot cost TASK-1 --json
- Then prices.file names the shipped defaults and prices.checked is a YYYY-MM-DD date
- And given .specpilot/prices.json with checked "2026-01-15", usdToEur 0.5 and a price for the model
- Then that file is used, its date is reported and its prices give the cost

### AC-8: Cost is summed per model and rounded once
- Given model-a priced input 1 USD per million and model-b priced input 3 USD per million, usdToEur 0.9
- And 3 messages of model-a with input 1666 each and 1 message of model-b with input 1000
- When I run specpilot cost TASK-1 --json
- Then usd is 0.01 (0.004998 + 0.003 = 0.007998, rounded once)
- And eur is 0.01 (0.0071982 rounded once)
- And per-message rounding, which would give 0, is not used

### AC-9: A model with no price is an error
- Given a counted message of model claude-unknown-1
- And prices.json has no entry for claude-unknown-1
- When I run specpilot cost TASK-1
- Then the command exits 1 with one line naming claude-unknown-1 and the prices file
- And no cost is printed

### AC-10: Latency runs from the first to the last counted message
- Given counted messages at 10:00:00.000 and 10:04:05.500, including a subagent message at 10:02:00.000
- When I run specpilot cost TASK-1 --json
- Then latencyMs is 245500
- And the text output shows Latency: 4m 05s

### AC-11: A window with no messages is an error
- Given TASK-1 has a window but no counted message of its sessions falls inside it
- When I run specpilot cost TASK-1
- Then the command exits 1 with one line saying TASK-1 has no messages in its window
- And no cost or latency is printed

### AC-12: Prints the report as text or JSON
- Given a done task with counted messages
- When I run specpilot cost TASK-1
- Then the output shows the tokens per type, the cost in USD and EUR, the latency, the mode and the prices file with its checked date
- And with --json, stdout is one JSON object with taskId, inProgress, tokens, usd, eur, latencyMs, mode and prices {file, checked}

### AC-13: Mode sets each agent's model from config
- Given .claude/agents/code-agent.md and tests-agent.md with model: haiku in their frontmatter
- When I run specpilot mode max
- Then both files have model: opus
- And when I run specpilot mode standard they have model: sonnet
- And given .specpilot/config.json with modes {"standard": "haiku", "max": "claude-opus-5-5"}, specpilot mode max writes model: claude-opus-5-5

### AC-14: Mode changes only the model line, and is idempotent
- Given an agent file with frontmatter, a model: line and a body
- When I run specpilot mode max
- Then every byte except the model: line is unchanged
- And a frontmatter with no model: line gets one added before the closing ---
- And running specpilot mode max again leaves every file byte for byte the same

### AC-15: Standard is the default and unknown modes are rejected
- Given no mode was ever set
- When I run specpilot mode
- Then it prints standard
- And specpilot cost reports mode standard
- And when I run specpilot mode turbo, the command exits 1 with one line naming turbo and the valid modes, and no file changes
