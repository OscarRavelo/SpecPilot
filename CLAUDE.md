# SpecPilot

SpecPilot is an AI framework for developing faster with spec-driven development (SDD) and test-driven development (TDD).
It is a TypeScript CLI: sources in `src/`, compiled to `dist/`, tests in `test/**/*.test.ts` (Jest + ts-jest).

## The loop (human in the loop)

1. The human approves the plan.
2. The tests agent writes tests from the spec (red).
3. The code agent writes code until the tests pass (green), then hands back to the tests agent.
4. The tests agent reruns the tests and reviews the result.
5. The human approves the final merge.

## Hard rules

- The code agent never edits tests.
- The tests agent never edits source code.
- Nobody marks a task done without running `npm test` and showing the output.
- No task is done until the mutation phase (Stryker) has run.
- Tests and code are always written by two different agents, a tests agent and a code agent, including while building SpecPilot itself. The orchestrating session writes neither.
- A surviving mutant in the mutation phase is a test gap, and nobody adds tests in mutation. The agent stops, reports the gap and runs `specpilot reopen <task> red`. Then the tests agent writes the missing test (it must fail first: `specpilot tdd red <task>`), the code agent goes back to green (`specpilot tdd green <task>`), and mutation runs again.

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

Stryker is not set up yet: `specpilot mutate` is planned (README roadmap step 7).
Until then the mutation phase cannot be completed.

## Conventions

- All repo content (code, messages, tests, docs) is in English.
- Update README.md in the same commit as every user-visible change.
