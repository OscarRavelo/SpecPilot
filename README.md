# SpecPilot

**AI coding agents that work from specs, and get tested and measured before you trust them.**

> 🚧 Early stage. I'm building this in public while learning AI engineering. Follow along on X: [@oscarravelo_ai](https://x.com/oscarravelo_ai)

## Core principle: zero friction

A developer clones SpecPilot into their project, answers a couple of setup questions, and starts working. No complex configuration.

## The problem

On a real enterprise project, I piloted Spec-Driven Development with AI agents. Two developers shipped at roughly 10x our usual speed. But three problems kept coming up:

1. **Hallucinations with no safety net.** The agent would say a task was done when it wasn't, and nothing checked it automatically.
2. **No idea what it cost.** We couldn't tell how much each task cost in tokens and money.
3. **A fragile workflow.** Asking a question or correcting the agent mid-task often knocked it out of the spec-driven flow (research, grill-me, plan, implement).

## Who it's for

Developers on multi-person teams in large companies, where work arrives as small, concrete tasks like "create an endpoint" or "add these fields to an existing endpoint", often in old, messy codebases.

## v0.1 scope (target: December 2026)

- Take a small task described in a spec and run a coding agent on it.
- **Verify** the result against the spec with tests, and flag claims of "done" that don't hold up.
- **Measure** the cost and latency of every task.
- Encourage the agent to **ask for context** when it's unsure, instead of guessing.

- **Two cost modes:** *Standard* minimizes token usage to fit a typical ~$30/month dev plan (our pilot spent ~$300 in one month); *Max* uses the most powerful model when there's no token limit.

## Harness

Stack assumed in target projects: **React + TypeScript** front end, **Node + TypeScript** back end, **Jest** tests (versions depend on the project).

SpecPilot is hybrid: the interactive phases run inside Claude Code (`.claude/` skills, subagents and hooks), while checks and metrics run in a Node CLI (`specpilot`, written in TypeScript) that works the same locally and in CI.

Every task moves through a strict state machine, and only the CLI can advance it when a phase's gate passes:

`research → grill → plan → red → green → mutation → verify → done`

- **Grill-me is a blocking gate.** The agent asks one question at a time until every checklist item (contract, validation, errors, data, auth, backwards compatibility, edge cases, what not to touch) has a source: the spec (`[spec:AC-2]`), the repo (`[repo:file:line "snippet"]`) or the human (`[human:Q7]`). Repo citations are checked mechanically, so an invented citation fails the gate. A clean-context auditor subagent then looks for gaps.
- **Rule #1: TDD, then prove the tests.** Tests are written first and must fail on an assertion. After the code turns them green, bugs are injected (Stryker plus one targeted bug per acceptance criterion). The tests must catch them; the bugs are then removed and the code must match the green version byte for byte. A bug the tests miss (a surviving mutant) is a test gap: the task goes back to red with `specpilot reopen <task> red`, the code agent puts the mutant back, the tests agent writes the missing test and sees it fail against the mutant, then the code agent removes the mutant (green) and mutation runs again. Tests are never added during mutation, and tests and code are always written by two different agents.
- **Verify** reruns everything independently. If the agent says "done" and it isn't, the task is blocked and counted as a hallucination.

Each task lives in `specs/<task-id>/spec.md` (start from [`templates/spec.md`](templates/spec.md)). The `id` must match the folder name, and `type` is one of `new-endpoint`, `endpoint-fields` or `react-component`. Acceptance criteria are written as `### AC-<n>: <title>` under `## Acceptance criteria`, with `- Given` / `- When` / `- Then` steps; `- And` continues the previous step:

```markdown
---
id: TASK-102
type: endpoint-fields
---
# Update phone number on PUT /users/:id

## Acceptance criteria

### AC-1: Sets a phone number on a user that had none
- Given a user with id 42 exists
- And their phone_number is null
- When I send PUT /users/42 with body {"phone_number": "+34623234321"}
- Then the response status is 200
- And the user with id 42 has phone_number "+34623234321"
```

The grill-me answers live next to the spec in `specs/<task-id>/grill.md` (start from [`templates/grill.md`](templates/grill.md)). Questions have a status (`open`, `answered`, or `assumption`, which needs `Approved: yes` from the human). Every fact must cite at least one source and is tagged with the checklist items it covers:

```markdown
## Facts

- (data) Users are updated by updateUser [repo:src/routes/users.ts:9 "export function updateUser("]
- (contract) A successful update responds 200 [spec:AC-1]
- (validation, errors) Invalid phone numbers respond 400 with INVALID_PHONE [human:Q1]
```

`specpilot ledger check` verifies each citation: a repo file must exist inside the project, the lines must exist, and the snippet (at least 8 characters) must appear literally in those lines. An acceptance criterion must exist in the spec, and a cited question must be answered or an approved assumption. An invented citation fails.

Each task type has a checklist the grill must cover (`specpilot grill checklist` shows it):

| Task type | Checklist items |
|---|---|
| `new-endpoint` | contract, validation, errors, data, auth, edge-cases, out-of-scope |
| `endpoint-fields` | contract, validation, errors, data, auth, compatibility, edge-cases, out-of-scope |
| `react-component` | contract, states, data, validation, errors, auth, accessibility, compatibility, edge-cases, out-of-scope |

The grill phase closes (`specpilot gate`) only when the ledger check is clean, no question is open, every checklist item and every acceptance criterion is covered by a cited fact, and the `grill-auditor` subagent has reviewed this exact spec and ledger with no blockers. The auditor writes `audit.md` with a hash of both files, so editing either one after the audit makes it stale.

Claude Code templates for this phase: the [`sp-grill` skill](templates/.claude/skills/sp-grill/SKILL.md), which runs the one-question-at-a-time loop, and the [`grill-auditor` subagent](templates/.claude/agents/grill-auditor.md), a clean-context reviewer that cannot edit code.

Phase hooks keep the agent inside the workflow. The [`settings.json` template](templates/.claude/settings.json) runs `specpilot hook pre-tool-use` before every `Write`, `Edit`, `MultiEdit`, `NotebookEdit` and `Bash` call, and blocks the edit (exit code 2, with the reason shown to the agent) when the task's phase does not allow it:

| Phase | Tests | Source code |
|---|---|---|
| `research`, `grill`, `plan` | blocked | blocked |
| `red` | allowed | blocked |
| `green`, `mutation` | blocked | allowed |
| `verify` | blocked | blocked |

Test files are `*.test.*` / `*.spec.*` and anything under `test/`, `tests/` or `__tests__/`; source code is any other `.ts`, `.tsx`, `.js` or `.jsx` file (including `.mjs`/`.cjs`). Other files, such as docs, the spec and the grill ledger, can always be edited. `state.json`, `red.json`, `green.json` and `mutation.json` can never be edited by the agent (only the CLI writes them), `equivalents.md` is approved only by the human, and `audit.md` can only be written by the `grill-auditor` subagent. With no active task, nothing is blocked. With several active tasks, an edit must be allowed by all of them, unless `SPECPILOT_TASK=<task-id>` chooses the one you are working on. A corrupt `state.json` blocks code and test edits instead of letting them through. For `Bash`, the hook finds the files a command writes: redirections (`>`, `>>`, `2>`, `&>`), `tee`, `sed -i`, `perl -i`, `cp`, `mv`, `rm`, `touch`, `truncate` and `dd of=`, across `&&`, `||`, `;` and pipes, skipping heredoc bodies. Known limit: files written from inside a program (`node -e`, `python -c`, `git apply`, `git checkout -- <file>`) are not detected.

With `--roles` (`specpilot hook pre-tool-use --roles`), the hook also enforces agent roles by the `agent_type` Claude Code passes for subagents: test files may only be edited by `tests-agent`, source code only by `code-agent`, those two agents may edit nothing else, and the main session and other agents may not edit tests or source code at all. Both the role and the phase must allow an edit. Roles are off by default, so a project without these two agents keeps working.

With `--roles`, `tests-agent` and `code-agent` may write files only with Edit or Write, never from Bash. For them a Bash command runs only if every part of it is on an allowlist of read-only commands, each with its own list of read-only options: `cat`, `head`, `tail`, `ls`, `wc`, `diff`, `grep`, `rg`, `find`, `echo`, `printf`, `pwd`, `true`, `which`, read-only `git` subcommands, `npm test`, `npm run typecheck`, `npm run build`, `npx jest` and `npx tsc --noEmit`. Each agent can also run only its own `specpilot` commands: `tests-agent` gets `status` and `tdd red <task>`; `code-agent` gets `status`, `tdd green <task>`, `mutate <task>` and `mutate bug <task> AC-n`. `gate` and `reopen` are left to the main session and the human. Anything the hook cannot classify is blocked: unknown programs or options, write redirections (only `/dev/null` and descriptor copies such as `2>&1` are allowed), `VAR=value` prefixes, `cd`, heredocs, `$(…)`, backticks, variable expansion, `$'…'`, unquoted backslashes and globs, `eval`/`exec`/`source` and unterminated quotes. The message reads `Blocked by SpecPilot: <agent> may not run this command from Bash (<reason>). Only allowlisted read-only commands may run; write files with Edit or Write. Allowed in Bash: …`. The main session and other agents keep the target-based Bash check described above.

Known limits of the Bash allowlist:

- `npm test`, `npx jest` and `specpilot tdd red|green` run code the agents wrote with Edit/Write. A test or source file can call `fs.writeFileSync` or `child_process`, and the allowlist does not limit what that code does.
- The hook runs from `dist/cli.js`, which is built from `src/`. `code-agent` could weaken `src/hooks.ts` and rebuild, and that would turn enforcement off for every agent. Changes to the hook also only take effect after a build.
- The tokenizer models POSIX/bash syntax, not zsh. Under zsh, process substitution `=(cmd)` and glob qualifiers such as `file(e:'cmd':)` are probably not blocked (only `<(` and `>(` are). Denying any unquoted `(` or `)` would close both.
- `npx tsc --noEmit -p <config>` with `"incremental": true` and a `tsBuildInfoFile` can write a `.tsbuildinfo` file.
- Read-only `git` commands follow the repository's git config (external diff, textconv, fsmonitor), so they are only safe while agents cannot edit `.git/config`.
- Not covered by design: glob characters inside double quotes, a lone `]`, `~` expansion, and extglob. `echo`, `printf`, `pwd`, `true` and `which` take any arguments; only their redirections are checked.

The same template registers `specpilot hook stop`, which runs whenever the agent stops. It does not block (that could leave the agent looping), but it shows a system message for every task in `mutation` or `verify`, e.g. `TASK-101 is in mutation, so the task is not done: run specpilot mutate TASK-101 and specpilot gate TASK-101.` Blocking a false "done" claim is part of step 8 (`verify`).

`specpilot tdd red <task>` and `specpilot tdd green <task>` run the project's tests with `npm test -- --json --outputFile=<tmp>` (so the `test` script must end with `jest`, e.g. `"jest"` or `"tsc && jest"`) and record evidence next to the spec:

- **Red** (`red.json`): at least one test fails, every failure is an `expect` assertion, and no suite fails to run. A test that throws, a missing module or a compile error is not red.
- **Green** (`green.json`): every test passes, and every test file is byte for byte the one recorded by `tdd red`: none changed, added or removed.

Both also record a hash of every source file, so mutation knows which code the task changed.

The `red` gate needs `red.json` with the tests unchanged since; the `green` gate needs `green.json`, matching both `red.json` and the current tests. To change a test after red, go back with `specpilot reopen <task> red`.

In the `mutation` phase the tests have to prove they catch bugs:

- **`specpilot mutate <task>`** runs [Stryker](https://stryker-mutator.io/) over the source files the task changed between `red.json` and `green.json`, plus every file mutated in an earlier round, so the set only grows after a reopen. Code and tests must be byte for byte the green version. The project needs `npm i -D @stryker-mutator/core @stryker-mutator/jest-runner @stryker-mutator/typescript-checker`; SpecPilot generates the Stryker config (Jest runner, plus the TypeScript checker when the project has a `tsconfig.json`, so a mutant that does not compile is not counted as caught). Only the mutated files get Stryker's `// @ts-nocheck`, so test fixtures keep their line numbers. The result goes to `mutation.json`. If Stryker exits with an error, nothing is recorded. Stryker's `.stryker-tmp/` and `reports/` folders are never hashed as code or tests.
- Every mutant that is not killed (`Survived`, `NoCoverage`, `Pending`, `RuntimeError`, or `Ignored` by a `// Stryker disable` comment) is listed in `specs/<task>/equivalents.md`, with an id made of `file:line mutator mutated-code`. Only the human can accept one as equivalent, by writing `- Approved: yes` and a `- Reason:` under its id. Approvals are kept when `mutate` runs again, as long as the id still matches exactly. Any other survivor is a test gap: `specpilot reopen <task> red`.
- **`specpilot mutate bug <task> AC-n`**: the code agent injects one targeted bug for the criterion and runs this command. The bug counts as caught only if a test with `AC-n` in its name fails on an assertion and no suite fails to run (so a bug that does not compile is not caught). Then the code agent removes the bug. A missed bug is a test gap, just like a surviving mutant: a later bug that is caught does not hide it, and the task goes back with `specpilot reopen <task> red`.

The `mutation` gate passes only when Stryker ran over the current code and tests, every survivor is approved in `equivalents.md`, every acceptance criterion has a caught bug and no missed one recorded after the current `tdd green` against the same tests, and code and tests are byte for byte the green version again (a leftover bug fails the gate).

Known limitation: SpecPilot's own CLI tests run the compiled `dist/cli.js`, which Stryker does not mutate, so mutants in the CLI code survive even when a CLI test covers that behaviour. Those survivors are real test gaps (they need unit tests that import `src/`) and are never approved as equivalents. Target projects whose tests import `src/` directly are not affected.

`specpilot mutate` escapes glob characters (`* ? ( ) [ ]`) in the file paths it gives Stryker, so a file like `src/[id].ts` is mutated and gets `// @ts-nocheck`, and nothing else does. A task file whose path has `{`, `}` or `,`, or a segment starting with `.`, stops `mutate` with a message to rename or move it and go back with `specpilot reopen <task> red`.

Known limits of the files `mutate` passes to Stryker:

- A task file at the project root whose name starts with `!` is never mutated: Stryker reads the entry as an exclude.
- A task file whose path ends in `:N-M` or `:N:C-M:C` is read by Stryker as a line range of another file.
- `mutate` does not check that every task file appears in Stryker's report, so a file Stryker skipped passes silently with 0 mutants.
- A project root with `[`, `]`, `{`, `}` or `,` in its path makes Stryker match no file at all, because Stryker does not escape the root.
- On POSIX, a backslash in a file name is turned into `/` by Stryker, so the entry can also match another file.
- Stryker always ignores `node_modules` (in any letter case) and symlinked files, and SpecPilot never hashes code under `dist/`, `build/`, `coverage/`, `reports/` or symlinks, so task code there is never mutated.
```bash
npx specpilot spec lint specs/TASK-101/spec.md   # check the spec format
npx specpilot ledger check TASK-101              # check every citation in the grill ledger
npx specpilot grill checklist TASK-101           # show covered and missing checklist items
npx specpilot grill hash TASK-101                # hash the auditor records in audit.md
npx specpilot status                             # show each task's phase
npx specpilot tdd red TASK-101                   # record that the new tests fail on assertions
npx specpilot tdd green TASK-101                 # record that all tests pass, unchanged since red
npx specpilot mutate TASK-101                    # run Stryker over the task's code
npx specpilot mutate bug TASK-101 AC-1           # check that the tests catch a bug injected for AC-1
npx specpilot gate TASK-101                      # close the current phase if its gate passes
npx specpilot reopen TASK-101 red                # go back (only plan→grill, mutation→red, verify→red)
```

## v0.1 progress

Every step is built with rule #1 on SpecPilot itself: tests first, then code, then injected bugs that the tests must catch.

| # | Step | Status | How it is checked |
|---|---|---|---|
| 0 | Project setup: TypeScript, Jest, CLI skeleton, CI | ✅ Done | Type check and `npm test` green on Node >=22 (CI: 22 and 24); `specpilot --help` lists the commands |
| 1 | Spec format and `spec lint` | ✅ Done | Valid and invalid fixtures give exact error codes and line numbers |
| 2 | Task state machine: `status`, `gate`, `reopen` | ✅ Done | Every illegal phase move is rejected; state persists in `state.json` |
| 3 | Grill ledger and citation checker: `ledger check` | ✅ Done | A real citation passes; a missing file, wrong line or altered snippet fails |
| 4 | Grill-me skill, checklist and auditor subagent | ✅ Done | A spec with a planted ambiguity cannot leave the grill phase; a stale or blocked audit fails the gate |
| 5 | Phase hooks in Claude Code | ✅ Done | Editing code before the red phase is blocked |
| 6 | `tdd red` / `tdd green` with evidence | ✅ Done | Red must fail on an assertion; tests cannot change after green |
| 7 | `mutate`: Stryker plus targeted bugs | ✅ Done | A weak test fails the gate; a leftover bug is detected; a bug that does not compile is not counted as caught |
| 8 | `verify` and the false "done" detector | — | A criterion with no test blocks the task and counts as a hallucination |
| 9 | Cost and latency metrics, Standard/Max modes | — | A known transcript gives exact tokens and € |
| 10 | `specpilot init` (zero friction) | — | Installs into sample React + TS and Node + TS projects; running it twice changes nothing |
| 11 | Evaluation on ~10 real tasks | — | `specpilot report` fills the success table below |

## Development

SpecPilot is written in TypeScript (`src/`) and compiled to `dist/`. It is built with two Claude Code subagents in [`.claude/agents/`](.claude/agents/): `tests-agent` writes the tests and may only edit `test/`, `code-agent` writes the code and may only edit `src/`, and the main session only coordinates. The repo's own [`.claude/settings.json`](.claude/settings.json) enforces this with `node dist/cli.js hook pre-tool-use --roles`, and it fails closed: if `dist/cli.js` is missing or the hook crashes, the edit is blocked and the agent is told to stop and ask the human how to fix it, one question at a time. Tests use Jest with ts-jest; the CLI tests run the compiled binary, so they check exactly what gets published.

Requires Node >= 22 (Stryker 10 needs it; `specpilot mutate` stops with a clear message on an older Node).

```bash
npm install
npm run typecheck   # tsc over src/ and test/
npm test            # builds dist/ and runs Jest
```

## Out of scope (for now)

- Keeping the agent on track when the user interrupts mid-task.
- Multi-agent orchestration, UI polish, and supporting every framework.

## How we measure success

Tested on ~10 real tasks in a legacy ("spaghetti") codebase:

| Metric | What it means |
|---|---|
| Success rate | % of tasks whose result passes the tests |
| Hallucination rate | % of tasks where the agent said "done" but was wrong |
| Useful questions | How often it asked for context instead of failing |
| Cost per task | Average € spent per task |

## Later (parked ideas)

- **v0.2 goal: Azure DevOps integration.** After a couple of setup questions, read work items, draft the spec from the PO's acceptance criteria, detect the Node version (front and back), and generate the best tests for that version.

- Recovering the spec-driven flow after a mid-task interruption.
- A GitHub Action that blocks PRs that fail the evals.
- An MCP server for spec-driven development.
