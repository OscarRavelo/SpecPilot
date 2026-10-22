---
id: step-11
type: cli-command
---
# `specpilot report` (roadmap step 11)

`specpilot report` prints one row per task of the current project, read from its `specs/` folder, so the user can measure SpecPilot on a real project. It only reads files.

## Definitions

- **Project root**: the current working directory.
- **Task**: each folder `specs/<task>/` that holds a `state.json`. A folder with no `state.json` (for example one with only `spec.md`, which `specpilot status` shows in research) is not a task for `report`.
- **Corrupt state.json**: what `loadState` already rejects: not valid JSON, a `taskId` that is not the folder name, an unknown `phase`, or a `history` that is not an array.
- **Corrupt hallucinations.json**: a `hallucinations.json` that is not a JSON array.
- **Columns**, in this order, separated by one tab: `task`, `phase`, `passed`, `rounds`, `hallucinations`, `cost_eur`.
- **task**: the folder name.
- **phase**: the `phase` field of `state.json`.
- **passed**: `yes` when `phase` is `done`, otherwise `no`.
- **rounds**: 1 + the number of `history` entries whose `to` is `red` and whose `from` is not `plan`.
- **hallucinations**: the number of entries in `specs/<task>/hallucinations.json`; 0 when the file does not exist.
- **cost_eur**: the EUR cost of the task, computed as `specpilot cost <task>` does, with 2 decimals (e.g. `1.24`). It is `—` when the task has no cost data: no counted message in its window, no transcript folder for the project, or an empty `history` (so no window).
- **Prices**: the same prices `specpilot cost` uses: `.specpilot/prices.json` when it exists, otherwise the defaults shipped with SpecPilot.
- Rows are sorted by task name; the first line is the header with the column names.

## Out of scope

- Charts (next version).
- A totals row, `--json` or any other option.
- Writing or changing any file.
- Changing `specpilot cost` or any other command.

## Acceptance criteria

### AC-1: One row per task with the 6 columns
- Given specs/alpha/state.json with phase "done" and specs/beta/state.json with phase "green", no backward moves and no hallucinations.json
- And transcripts that cost 1.24 EUR for alpha and 0.50 EUR for beta
- When I run specpilot report
- Then the command exits 0
- And stdout is exactly 3 lines:
  "task\tphase\tpassed\trounds\thallucinations\tcost_eur"
  "alpha\tdone\tyes\t1\t0\t1.24"
  "beta\tgreen\tno\t1\t0\t0.50"

### AC-2: Rounds count the returns to red
- Given a task whose history has plan→red, red→green, green→mutation, mutation→red, red→green
- When I run specpilot report
- Then its rounds column is 2
- And given a task whose history also has green→mutation, mutation→verify, verify→red after that
- Then its rounds column is 3

### AC-3: Hallucinations count the entries
- Given a task whose hallucinations.json has 3 entries
- When I run specpilot report
- Then its hallucinations column is 3
- And a task with no hallucinations.json shows 0

### AC-4: A task with no cost data shows —
- Given a task with no counted message in its window
- When I run specpilot report
- Then its cost_eur column is "—" and the command exits 0
- And given a project with no transcript folder, every task's cost_eur is "—" and the command exits 0
- And given a task whose state.json has an empty history, its cost_eur is "—" and the command exits 0

### AC-5: No tasks
- Given a project with no specs/ folder, or a specs/ folder with no state.json in it
- When I run specpilot report
- Then the command exits 0
- And stdout is exactly "no tasks found in specs/"
- And given specs/alpha/state.json and specs/beta/ with only a spec.md, stdout has the header and one row, for alpha

### AC-6: Corrupt state.json or hallucinations.json
- Given specs/alpha/state.json that is not valid JSON, has a taskId other than alpha, has an unknown phase, or has a history that is not an array
- When I run specpilot report
- Then the command exits 2
- And stderr is one line that names specs/alpha
- And stdout is empty
- And given specs/alpha/hallucinations.json that is not a JSON array, the command exits 2, stderr is one line that names specs/alpha and hallucinations.json, and stdout is empty

### AC-7: Read-only and no longer "not implemented"
- Given any project from AC-1 to AC-6
- When I run specpilot report
- Then every file in the project has the same bytes and mtime as before
- And "report" is not in NOT_IMPLEMENTED in src/cli.ts and does not print "is not implemented yet"
- And specpilot cost <task> prints the same as before this step

### AC-8: Prices: shipped defaults, a corrupt file and a model with no price
- Given a project with tasks and no .specpilot/prices.json
- When I run specpilot report
- Then the cost uses the prices shipped with SpecPilot and the command exits 0
- And given a .specpilot/prices.json that is not valid (as in step 9 AC-7), the command exits 2
- And given a counted message of a model with no price, the command exits 2
- And in both cases stderr is the same one line that specpilot cost <task> prints, and stdout is empty
