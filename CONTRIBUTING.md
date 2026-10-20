# Contributing to SpecPilot

Thanks for your interest. SpecPilot is built with its own workflow, so contributions follow the same rules.

## Setup

```bash
npm install
npm run typecheck   # tsc over src/ and test/
npm test            # builds dist/ and runs Jest
```

Node >= 22 is required. CI runs the type check and `npm test` on Node 22 and 24.

## How changes are made

1. A human approves the plan before any code is written.
2. Tests come first and must fail on an assertion (red), then code makes them pass (green).
3. Tests and code are written by two different agents: `tests-agent` edits only `test/`, `code-agent` edits only `src/` (see [Agent roles](docs/roles.md)). They never run at the same time.
4. At most three red/green rounds per task; anything left after round 3 goes into [Known limits](docs/known-limits.md).
5. Nobody marks a task done without running `npm test` and showing the output.
6. A human approves the final merge.

[`CLAUDE.md`](CLAUDE.md) has the full rules.

## Conventions

- All repo content (code, messages, tests, docs) is in English.
- Update `README.md` (and `docs/` when reference behaviour changes) in the same commit as every user-visible change.
- Acceptance criteria follow the [ground rules](README.md#ground-rules): testable, with a clear Given/When/Then and concrete values.

## Reporting issues

Open a GitHub issue with the command you ran, its full output and your Node version.
