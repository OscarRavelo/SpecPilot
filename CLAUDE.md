# SpecPilot

SpecPilot is an AI framework for developing faster with spec-driven development (SDD) and test-driven development (TDD).
It is a TypeScript CLI: sources in `src/`, compiled to `dist/`, tests in `test/**/*.test.ts` (Jest + ts-jest).

## The loop (human in the loop)

1. The human approves the plan.
2. `code-agent` creates compiling stubs; `tests-agent` writes tests from the spec that fail on assertions (red).
3. `code-agent` writes code until the tests pass (green), then hands back to `tests-agent`.
4. `tests-agent` reruns the tests and reviews the result.
5. The human approves the final merge.

Specs for SpecPilot's own steps live in `docs/specs/`, never in `specs/`: a `specs/<id>/` folder becomes an active task, and the phase hook then blocks both agents.

Never run tests-agent and code-agent at the same time. Each step waits for the previous one to finish; any new test, including pinning tests, is written and run before code-agent starts the next green step.

Every red step, in every round: show the human the red tests with the Jest output, wait for their "ok", commit the red (spec and tests only), and only then start code-agent. The green goes in its own commit.

A task gets at most 3 red/green rounds to look for new gaps; whatever the round 3 review still finds goes into the README known limits, with no round 4. The limit does not stop the human from approving tests that close mutants an audit of equivalent survivors shows are not equivalent.

Every time a commit is pushed to a branch with an open PR, update the PR title and description with `gh pr edit` so they cover everything the branch now holds (red and green phases, review rounds, decisions taken), not only the first commit.

## Hard rules

- Nobody marks a task done without running `npm test` and showing the output.
- Developing SpecPilot itself: mutation (Stryker over the code changed since the previous release) is required before each release (v0.1, v0.2, ...), not for every task. A task is done once its tests are green and reviewed.
- Projects that use SpecPilot are not affected: there, `specpilot mutate` stays mandatory for every task, and no task is done until its mutation gate passes.
- SpecPilot itself is built with two subagents in `.claude/agents/`: `tests-agent` may only edit `test/`, `code-agent` may only edit `src/`.
- Both agents write files only with Edit/Write. The hook blocks any Bash command of theirs that is not on its read-only allowlist, and it blocks anything it cannot classify.
- The main session only coordinates: it calls the agents, runs `npm test` and reports to the human. It never edits `test/` or `src/` directly.
- `.claude/settings.json` enforces these roles with `specpilot hook pre-tool-use --roles`, run from `dist/` (`npm run build` first). If the hook itself fails, every edit is blocked: stop and ask the human how to fix it, one question at a time, before doing anything else.
- A surviving mutant is a test gap, and nobody adds tests in mutation. The agent stops, reports the gap and runs `specpilot reopen <task> red`. Then `code-agent` puts the surviving mutant back, `tests-agent` writes the missing test and sees it fail against the mutant (red: `specpilot tdd red <task>`), `code-agent` removes the mutant (green: `specpilot tdd green <task>`), and mutation runs again.

## Phases

`research → grill → plan → red → green → mutation → verify → done`

Track and move tasks with the CLI (after `npm run build`):

```
npx specpilot status                  # show each task's phase
npx specpilot gate <task>             # check the current phase and advance if it passes
npx specpilot reopen <task> <phase>   # go back to an allowed earlier phase
```

## Commands

The main command. The hard rules require running it and showing its output:

```
npm test            # build + jest
```

Other commands:

```
npm run typecheck   # tsc type check, no emit
npm run build       # compile src/ → dist/
```

Mutation (Stryker is a devDependency). In projects that use SpecPilot this runs for every task; in SpecPilot itself, before each release:

```
npx specpilot mutate <task>           # Stryker over the task's code; survivors go to equivalents.md
npx specpilot mutate bug <task> AC-n  # code-agent injects a bug for AC-n, then removes it
```

Only the human approves an equivalent mutant in `specs/<task>/equivalents.md`.
Survivors in the CLI code (tests run `dist/cli.js`) are never approved as equivalents. This means code that is only tested through `dist/cli.js`; a module with its own unit tests that import `src/` (such as `src/cost.ts` or `src/mode.ts`) is judged on those tests, and its survivors can be approved as equivalent.

## Conventions

- All repo content (code, messages, tests, docs) is in English.
- Update README.md in the same commit as every user-visible change.
