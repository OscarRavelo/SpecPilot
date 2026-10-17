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

Stack assumed in target projects: **React** front end, **Node** back end, **Jest** tests (versions depend on the project).

SpecPilot is hybrid: the interactive phases run inside Claude Code (`.claude/` skills, subagents and hooks), while checks and metrics run in a Node CLI (`specpilot`, written in TypeScript) that works the same locally and in CI.

Every task moves through a strict state machine, and only the CLI can advance it when a phase's gate passes:

`research → grill → plan → red → green → mutation → verify → done`

- **Grill-me is a blocking gate.** The agent asks one question at a time until every checklist item (contract, validation, errors, data, auth, backwards compatibility, edge cases, what not to touch) has a source: the spec (`[spec:AC-2]`), the repo (`[repo:file:line "snippet"]`) or the human (`[human:Q7]`). Repo citations are checked mechanically, so an invented citation fails the gate. A clean-context auditor subagent then looks for gaps.
- **Rule #1: TDD, then prove the tests.** Tests are written first and must fail on an assertion. After the code turns them green, bugs are injected (Stryker plus one targeted bug per acceptance criterion). The tests must catch them; the bugs are then removed and the code must match the green version byte for byte.
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

```bash
npx specpilot spec lint specs/TASK-101/spec.md   # check the spec format
npx specpilot status                             # show each task's phase
npx specpilot gate TASK-101                      # close the current phase if its gate passes
npx specpilot reopen TASK-101 red                # go back (only plan→grill, mutation→red, verify→red)
```

## v0.1 progress

Every step is built with rule #1 on SpecPilot itself: tests first, then code, then injected bugs that the tests must catch.

| # | Step | Status | How it is checked |
|---|---|---|---|
| 0 | Project setup: TypeScript, Jest, CLI skeleton, CI | ✅ Done | Type check and `npm test` green on Node 18/20/22; `specpilot --help` lists the commands |
| 1 | Spec format and `spec lint` | ✅ Done | Valid and invalid fixtures give exact error codes and line numbers |
| 2 | Task state machine: `status`, `gate`, `reopen` | ✅ Done | Every illegal phase move is rejected; state persists in `state.json` |
| 3 | Grill ledger and citation checker | ⏳ Next | A real citation passes; a missing file, wrong line or altered snippet fails |
| 4 | Grill-me skill, checklist and auditor subagent | — | A spec with a planted ambiguity cannot leave the grill phase |
| 5 | Phase hooks in Claude Code | — | Editing code before the red phase is blocked |
| 6 | `tdd red` / `tdd green` with evidence | — | Red must fail on an assertion; tests cannot change after green |
| 7 | `mutate`: Stryker plus targeted bugs | — | A weak test fails the gate; a leftover bug is detected |
| 8 | `verify` and the false "done" detector | — | A criterion with no test blocks the task and counts as a hallucination |
| 9 | Cost and latency metrics, Standard/Max modes | — | A known transcript gives exact tokens and € |
| 10 | `specpilot init` (zero friction) | — | Installs into sample React and Node projects; running it twice changes nothing |
| 11 | Evaluation on ~10 real tasks | — | `specpilot report` fills the success table below |

## Development

SpecPilot is written in TypeScript (`src/`) and compiled to `dist/`. Tests use Jest with ts-jest; the CLI tests run the compiled binary, so they check exactly what gets published.

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
