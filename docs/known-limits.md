# Known limits

[← Back to the README](../README.md)

Every limit SpecPilot knows about in v0.1, grouped by feature.

## Phase hooks

- Files written from inside a program (`node -e`, `python -c`, `git apply`, `git checkout -- <file>`) are not detected by the target-based Bash check ([Phase hooks](hooks.md#bash-commands)).

## init

- A SpecPilot hook the project already has is left as it is: `init` does not widen a narrower matcher or add `--no` to its `npx` command.
- `init` only warns about missing packages (Jest, Stryker, `specpilot`); it never installs them.
- SpecPilot is not published to npm yet, so it is installed from a `npm pack` tarball.

## Bash allowlist

Known limits of the [Bash allowlist](roles.md#the-bash-allowlist) (`--roles`):

- `npm test`, `npx jest` and `specpilot tdd red|green` run code the agents wrote with Edit/Write. A test or source file can call `fs.writeFileSync` or `child_process`, and the allowlist does not limit what that code does.
- The hook runs from `dist/cli.js`, which is built from `src/`. `code-agent` could weaken `src/hooks.ts` and rebuild, and that would turn enforcement off for every agent. Changes to the hook also only take effect after a build.
- The tokenizer models POSIX/bash syntax, not zsh. Under zsh, process substitution `=(cmd)` and glob qualifiers such as `file(e:'cmd':)` are probably not blocked (only `<(` and `>(` are). Denying any unquoted `(` or `)` would close both.
- `npx tsc --noEmit -p <config>` with `"incremental": true` and a `tsBuildInfoFile` can write a `.tsbuildinfo` file.
- Read-only `git` commands follow the repository's git config (external diff, textconv, fsmonitor), so they are only safe while agents cannot edit `.git/config`.
- Not covered by design: glob characters inside double quotes, a lone `]`, `~` expansion, and extglob. `echo`, `printf`, `pwd`, `true` and `which` take any arguments; only their redirections are checked.

## Mutation

SpecPilot's own CLI tests run the compiled `dist/cli.js`, which Stryker does not mutate, so mutants in the CLI code survive even when a CLI test covers that behaviour. Those survivors are real test gaps (they need unit tests that import `src/`) and are never approved as equivalents. Target projects whose tests import `src/` directly are not affected.

Known limits of the files [`mutate`](verify.md#mutation) passes to Stryker:

- A task file at the project root whose name starts with `!` is never mutated: Stryker reads the entry as an exclude.
- A task file whose path ends in `:N-M` or `:N:C-M:C` is read by Stryker as a line range of another file.
- A task whose only changed files have nothing to mutate (types only) always fails `mutate`: Stryker leaves every task file out of its report, and `mutate` treats that as a failed run.
- A project root whose path forms a glob, such as a `[...]` character class or a `{a,b}` list, makes Stryker match no file at all, because Stryker does not escape the root. `mutate` now stops before Stryker starts and names the file. A lone `,`, `!`, `*`, `?`, `(` or unpaired bracket in the root still matches (checked with minimatch 10).
- The "Stryker would skip" message blames the project root whenever the root contains any of `*?[]{}(),!`, even if the root still matches and the mismatch has another cause.
- `mutation.json` checks only that `noMutants` is a list, not that each item is a path (the same loose check as `files`).
- On POSIX, a backslash in a file name is turned into `/` by Stryker, so the entry can also match another file.
- Stryker always ignores `node_modules` (in any letter case) and symlinked files, and SpecPilot never hashes code under `dist/`, `build/`, `coverage/`, `reports/` or symlinks, so task code there is never mutated.

## Verify

Known limits of [`verify`](verify.md#verify-the-false-done-detector) (v0.1):

- Coverage is by name only: a test with `AC-n` in its name covers that criterion even if its assertions check something else. That is why a human reviews the tests (see the [ground rules](../README.md#ground-rules)).
- `verify` does not run Stryker again; it only checks that the mutation evidence still matches the code and tests.
- Nothing protects `hallucinations.json`: an agent could edit or delete it.
- Only `verify` records hallucinations; a failing `gate` in an earlier phase is not counted as one.
- Hallucinations are not aggregated across tasks yet.
- Coverage counts passing tests from the whole repo, not only the task's own test files: AC ids repeat across specs (every task has an `AC-1`), so a test named `AC-2 …` written for another task also covers this task's `AC-2`.
- `hallucinations.json` is rewritten whole, not atomically: a write that fails part way (for example, a full disk) can cut it short and lose earlier entries, although `verify` still exits 2.
- The test for a write that fails is skipped when the tests run as root, because root ignores the read-only folder it relies on.
- If another process corrupts `hallucinations.json` between the check before the tests and the write, `verify` reports it as `Cannot write …: Corrupt hallucinations.json …` (still exit 2, nothing recorded).
- `hallucinations.json` only has to hold a JSON array to be read; its entries are not checked.

## Cost and modes

Known limits of [`cost` and `mode`](cost.md):

- A session counts for a task only if it runs a `specpilot` command naming the task. A session that works on the task without running one is not counted, and a session that runs commands for two overlapping tasks is counted for both.
- Cache writes use one price (the 5-minute one); 1-hour cache writes are undercharged.
- The default prices leave out Claude Haiku 5.5, whose price depends on prompt size, and any model whose ID was not confirmed on the pricing page. Add them in `.specpilot/prices.json`.
- The mode in the `cost` report is the current mode, not the one the task ran with.
- `mode` rewrites every `.claude/agents/*.md`, including agents that are not part of the workflow.
- Windows is not supported in v0.1 (development is on macOS and CI runs on Linux). `cost` and `mode` rely on Node's `readdirSync` returning names in sorted order, as it does on macOS and Linux; on Windows, `mode` could list the updated agent files in a different order, or name a different file when two are broken.
- The transcript folder name follows Claude Code's current rule; if Claude Code changes it, `cost` reports the folder as missing.

## Workflow

- The `plan` gate is not implemented yet: `specpilot gate` in `plan` fails with `The plan gate is not implemented yet`.
