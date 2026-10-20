# Agent roles (`--roles`)

[← Back to the README](../README.md)

With `--roles` (`specpilot hook pre-tool-use --roles`), the [phase hook](hooks.md) also enforces agent roles by the `agent_type` Claude Code passes for subagents: test files may only be edited by `tests-agent`, source code only by `code-agent`, those two agents may edit nothing else, and the main session and other agents may not edit tests or source code at all. Both the role and the phase must allow an edit. Roles are off by default, so a project without these two agents keeps working.

## The Bash allowlist

With `--roles`, `tests-agent` and `code-agent` may write files only with Edit or Write, never from Bash. For them a Bash command runs only if every part of it is on an allowlist of read-only commands, each with its own list of read-only options: `cat`, `head`, `tail`, `ls`, `wc`, `diff`, `grep`, `rg`, `find`, `echo`, `printf`, `pwd`, `true`, `which`, read-only `git` subcommands, `npm test`, `npm run typecheck`, `npm run build`, `npx jest` and `npx tsc --noEmit`.

Each agent can also run only its own `specpilot` commands: `tests-agent` gets `status` and `tdd red <task>`; `code-agent` gets `status`, `tdd green <task>`, `mutate <task>` and `mutate bug <task> AC-n`. `gate` and `reopen` are left to the main session and the human.

Anything the hook cannot classify is blocked: unknown programs or options, write redirections (only `/dev/null` and descriptor copies such as `2>&1` are allowed), `VAR=value` prefixes, `cd`, heredocs, `$(…)`, backticks, variable expansion, `$'…'`, unquoted backslashes and globs, `eval`/`exec`/`source` and unterminated quotes. The message reads `Blocked by SpecPilot: <agent> may not run this command from Bash (<reason>). Only allowlisted read-only commands may run; write files with Edit or Write. Allowed in Bash: …`.

The main session and other agents keep the target-based Bash check described in [Phase hooks](hooks.md#bash-commands).

See the [known limits of the Bash allowlist](known-limits.md#bash-allowlist).

## How SpecPilot itself uses roles

SpecPilot is built with two Claude Code subagents in [`.claude/agents/`](../.claude/agents/): `tests-agent` writes the tests and may only edit `test/`, `code-agent` writes the code and may only edit `src/`, and the main session only coordinates. The repo's own [`.claude/settings.json`](../.claude/settings.json) enforces this with `node dist/cli.js hook pre-tool-use --roles`, and it fails closed: if `dist/cli.js` is missing or the hook crashes, the edit is blocked and the agent is told to stop and ask the human how to fix it, one question at a time.
