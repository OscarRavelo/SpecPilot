# Spec format and the grill-me phase

[← Back to the README](../README.md)

## Spec format

Each task lives in `specs/<task-id>/spec.md` (start from [`templates/spec.md`](../templates/spec.md)). The `id` must match the folder name, and `type` is one of `new-endpoint`, `endpoint-fields`, `react-component` or `cli-command`. Acceptance criteria are written as `### AC-<n>: <title>` under `## Acceptance criteria`, with `- Given` / `- When` / `- Then` steps; `- And` continues the previous step:

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

`npx specpilot spec lint specs/<task-id>/spec.md` checks the format.

## Grill-me is a blocking gate

The agent asks one question at a time until every checklist item (contract, validation, errors, data, auth, backwards compatibility, edge cases, what not to touch) has a source: the spec (`[spec:AC-2]`), the repo (`[repo:file:line "snippet"]`) or the human (`[human:Q7]`). Repo citations are checked mechanically, so an invented citation fails the gate. A clean-context auditor subagent then looks for gaps.

## The grill ledger

The grill-me answers live next to the spec in `specs/<task-id>/grill.md` (start from [`templates/grill.md`](../templates/grill.md)). Questions have a status (`open`, `answered`, or `assumption`, which needs `Approved: yes` from the human). Every fact must cite at least one source and is tagged with the checklist items it covers:

```markdown
## Facts

- (data) Users are updated by updateUser [repo:src/routes/users.ts:9 "export function updateUser("]
- (contract) A successful update responds 200 [spec:AC-1]
- (validation, errors) Invalid phone numbers respond 400 with INVALID_PHONE [human:Q1]
```

`specpilot ledger check` verifies each citation: a repo file must exist inside the project, the lines must exist, and the snippet (at least 8 characters) must appear literally in those lines. An acceptance criterion must exist in the spec, and a cited question must be answered or an approved assumption. An invented citation fails.

## Checklists by task type

Each task type has a checklist the grill must cover (`specpilot grill checklist` shows it):

| Task type | Checklist items |
|---|---|
| `new-endpoint` | contract, validation, errors, data, auth, edge-cases, out-of-scope |
| `endpoint-fields` | contract, validation, errors, data, auth, compatibility, edge-cases, out-of-scope |
| `react-component` | contract, states, data, validation, errors, auth, accessibility, compatibility, edge-cases, out-of-scope |
| `cli-command` | contract, files, errors, compatibility, edge-cases, out-of-scope |

## The grill gate

The grill phase closes (`specpilot gate`) only when the ledger check is clean, no question is open, every checklist item and every acceptance criterion is covered by a cited fact, and the `grill-auditor` subagent has reviewed this exact spec and ledger with no blockers. The auditor writes `audit.md` with a hash of both files, so editing either one after the audit makes it stale.

## Claude Code templates

Claude Code templates for this phase: the [`sp-grill` skill](../templates/.claude/skills/sp-grill/SKILL.md), which runs the one-question-at-a-time loop, and the [`grill-auditor` subagent](../templates/.claude/agents/grill-auditor.md), a clean-context reviewer that cannot edit code.

```bash
npx specpilot ledger check TASK-101              # check every citation in the grill ledger
npx specpilot grill checklist TASK-101           # show covered and missing checklist items
npx specpilot grill hash TASK-101                # hash the auditor records in audit.md
```
