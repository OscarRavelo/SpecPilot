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

## Para después (ideas parked for later)

- **v0.2 goal: Azure DevOps integration.** After a couple of setup questions, read work items, draft the spec from the PO's acceptance criteria, detect the Node version (front and back), and generate the best tests for that version.

- Recovering the spec-driven flow after a mid-task interruption.
- A GitHub Action that blocks PRs that fail the evals.
- An MCP server for spec-driven development.
