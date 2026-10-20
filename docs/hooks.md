# Phase hooks

[← Back to the README](../README.md)

Phase hooks keep the agent inside the workflow. The [`settings.json` template](../templates/.claude/settings.json) runs `specpilot hook pre-tool-use` before every `Write`, `Edit`, `MultiEdit`, `NotebookEdit` and `Bash` call, and blocks the edit (exit code 2, with the reason shown to the agent) when the task's phase does not allow it:

| Phase | Tests | Source code |
|---|---|---|
| `research`, `grill`, `plan` | blocked | blocked |
| `red` | allowed | blocked |
| `green`, `mutation` | blocked | allowed |
| `verify` | blocked | blocked |

## What counts as a test, source code or a protected file

Test files are `*.test.*` / `*.spec.*` and anything under `test/`, `tests/` or `__tests__/`; source code is any other `.ts`, `.tsx`, `.js` or `.jsx` file (including `.mjs`/`.cjs`). Other files, such as docs, the spec and the grill ledger, can always be edited. `state.json`, `red.json`, `green.json` and `mutation.json` can never be edited by the agent (only the CLI writes them), `equivalents.md` is approved only by the human, and `audit.md` can only be written by the `grill-auditor` subagent.

## Which task applies

With no active task, nothing is blocked. With several active tasks, an edit must be allowed by all of them, unless `SPECPILOT_TASK=<task-id>` chooses the one you are working on. A corrupt `state.json` blocks code and test edits instead of letting them through.

## Bash commands

For `Bash`, the hook finds the files a command writes: redirections (`>`, `>>`, `2>`, `&>`), `tee`, `sed -i`, `perl -i`, `cp`, `mv`, `rm`, `touch`, `truncate` and `dd of=`, across `&&`, `||`, `;` and pipes, skipping heredoc bodies. Files written from inside a program are not detected (see [known limits](known-limits.md#phase-hooks)).

With `--roles`, `tests-agent` and `code-agent` get a stricter, allowlist-based Bash check instead: see [Agent roles](roles.md).

## The stop hook

The same template registers `specpilot hook stop`, which runs whenever the agent stops. It does not block (that could leave the agent looping), but it shows a system message for every task in `mutation` or `verify`, e.g. `TASK-101 is in mutation, so the task is not done: run specpilot mutate TASK-101 and specpilot gate TASK-101.` or `TASK-101 is in verify, so the task is not done: run specpilot verify TASK-101.` A false "done" claim is blocked by `specpilot verify`, which records it as a hallucination (see [Red, green, mutation and verify](verify.md)).
