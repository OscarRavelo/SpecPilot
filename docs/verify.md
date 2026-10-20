# Red, green, mutation and verify

[← Back to the README](../README.md)

**Rule #1: TDD, then prove the tests.** Tests are written first and must fail on an assertion. After the code turns them green, bugs are injected (Stryker plus one targeted bug per acceptance criterion). The tests must catch them; the bugs are then removed and the code must match the green version byte for byte. A bug the tests miss (a surviving mutant) is a test gap: the task goes back to red with `specpilot reopen <task> red`, the code agent puts the mutant back, the tests agent writes the missing test and sees it fail against the mutant, then the code agent removes the mutant (green) and mutation runs again. Tests are never added during mutation, and tests and code are always written by two different agents.

## Red and green evidence

`specpilot tdd red <task>` and `specpilot tdd green <task>` run the project's tests with `npm test -- --json --outputFile=<tmp>` (so the `test` script must end with `jest`, e.g. `"jest"` or `"tsc && jest"`) and record evidence next to the spec:

- **Red** (`red.json`): at least one test fails, every failure is an `expect` assertion, and no suite fails to run. A test that throws, a missing module or a compile error is not red.
- **Green** (`green.json`): every test passes, and every test file is byte for byte the one recorded by `tdd red`: none changed, added or removed.

Both also record a hash of every source file, so mutation knows which code the task changed.

The `red` gate needs `red.json` with the tests unchanged since; the `green` gate needs `green.json`, matching both `red.json` and the current tests. To change a test after red, go back with `specpilot reopen <task> red`.

## Mutation

In the `mutation` phase the tests have to prove they catch bugs:

- **`specpilot mutate <task>`** runs [Stryker](https://stryker-mutator.io/) over the source files the task changed between `red.json` and `green.json`, plus every file mutated in an earlier round, so the set only grows after a reopen. Code and tests must be byte for byte the green version. The project needs `npm i -D @stryker-mutator/core @stryker-mutator/jest-runner @stryker-mutator/typescript-checker`; SpecPilot generates the Stryker config (Jest runner, plus the TypeScript checker when the project has a `tsconfig.json`, so a mutant that does not compile is not counted as caught). Only the mutated files get Stryker's `// @ts-nocheck`, so test fixtures keep their line numbers. The result goes to `mutation.json`. If Stryker exits with an error, nothing is recorded. Before Stryker starts, `mutate` checks that each file's `mutate` entry matches it the way Stryker's own matcher does (with the `minimatch` Stryker loads); if one does not, it stops with a one-line message naming the file. A task file that Stryker leaves out of its report (such as a file with only types) is not an error: `mutate` prints `no mutants: <file>` and records it under `noMutants` in `mutation.json`. If Stryker leaves every task file out, `mutate` fails and records nothing. Stryker's `.stryker-tmp/` and `reports/` folders are never hashed as code or tests.
- Every mutant that is not killed (`Survived`, `NoCoverage`, `Pending`, `RuntimeError`, or `Ignored` by a `// Stryker disable` comment) is listed in `specs/<task>/equivalents.md`, with an id made of `file:line mutator mutated-code`. Only the human can accept one as equivalent, by writing `- Approved: yes` and a `- Reason:` under its id. Approvals are kept when `mutate` runs again, as long as the id still matches exactly. Any other survivor is a test gap: `specpilot reopen <task> red`.
- **`specpilot mutate bug <task> AC-n`**: the code agent injects one targeted bug for the criterion and runs this command. The bug counts as caught only if a test with `AC-n` in its name fails on an assertion and no suite fails to run (so a bug that does not compile is not caught). Then the code agent removes the bug. A missed bug is a test gap, just like a surviving mutant: a later bug that is caught does not hide it, and the task goes back with `specpilot reopen <task> red`.

The `mutation` gate passes only when Stryker ran over the current code and tests, every survivor is approved in `equivalents.md`, every acceptance criterion has a caught bug and no missed one recorded after the current `tdd green` against the same tests, and code and tests are byte for byte the green version again (a leftover bug fails the gate).

`specpilot mutate` escapes glob characters (`* ? ( ) [ ]`) in the file paths it gives Stryker, so a file like `src/[id].ts` is mutated and gets `// @ts-nocheck`, and nothing else does. A task file whose path has `{`, `}` or `,`, or a segment starting with `.`, stops `mutate` with a message to rename or move it and go back with `specpilot reopen <task> red`.

See the [known limits of mutation](known-limits.md#mutation).

## Verify: the false "done" detector

**`specpilot verify <task>`** is the only way from `verify` to `done` (`specpilot gate` in `verify` just says to run it). **Verify** reruns everything independently: if the agent says "done" and it isn't, the task is blocked and counted as a hallucination. It reruns the checks itself instead of trusting the agent's claim:

1. the `mutation` gate again (code and tests byte for byte the green version, Stryker evidence fresh, survivors approved, a caught bug for every acceptance criterion);
2. a fresh `npm test`, where every suite must run and every test pass;
3. coverage of every acceptance criterion: each `AC-n` in the spec needs at least one **passing** test whose name holds `AC-n` as a whole id (the same rule as `mutate bug`: `AC-1` is not `AC-12` or `AC-1.2`).

If everything holds, it prints one `✓ AC-n (k tests)` line per criterion, moves the task to `done` and exits 0. If anything fails, the agent claimed done when it was not: the task stays in `verify`, the reasons are appended as a hallucination to `specs/<task>/hallucinations.json` (never truncated), and `verify` exits 1 with `Go back with specpilot reopen <task> red`. A spec with no acceptance criteria also blocks the task. When `verify` cannot run at all (wrong usage, no such task, a phase other than `verify`, a corrupt `state.json`, an unreadable spec, a corrupt `hallucinations.json`, checked before the tests run, no Jest report, or a blocked run whose `hallucinations.json` cannot be written, e.g. `Cannot write specs/TASK-101/hallucinations.json: EACCES: permission denied, …`), it prints one line, records nothing and exits 2.

See the [known limits of verify](known-limits.md#verify).

```bash
npx specpilot tdd red TASK-101                   # record that the new tests fail on assertions
npx specpilot tdd green TASK-101                 # record that all tests pass, unchanged since red
npx specpilot mutate TASK-101                    # run Stryker over the task's code
npx specpilot mutate bug TASK-101 AC-1           # check that the tests catch a bug injected for AC-1
npx specpilot verify TASK-101                    # rerun the checks: move to done, or record a hallucination
```
