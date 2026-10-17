---
name: sp-grill
description: SpecPilot grill-me phase. Use when a task under specs/<task-id>/ is in the grill phase, to interview the human until every checklist item and acceptance criterion rests on a verifiable source, get the ledger audited, and close the phase.
---

# SpecPilot grill-me

Before any plan or code exists, turn every ambiguity in the spec into a fact with a source you can prove. Never guess: a fact without a source is a hallucination waiting to happen.

## Rules

1. Ask **one question at a time**. Give 2–4 concrete options and say which one you recommend and why. Wait for the answer before asking the next question.
2. Look in the code before asking. If the code answers the question, record a fact with a repo citation instead of asking.
3. Never write a fact you cannot cite. Every fact in `grill.md` needs at least one citation:
   - `[repo:<file>:<line>[-<line>] "<exact snippet>"]`: copy the snippet from the file, character for character, at least 8 characters, and cite the lines where it is.
   - `[spec:AC-<n>]`: an acceptance criterion in `spec.md`.
   - `[human:Q<n>]`: a question the human answered, or an assumption the human approved.
4. Tag every fact with the checklist items it covers: `- (errors, validation) Invalid phones respond 400 [human:Q1]`. "Not applicable" is still a fact and still needs a source, usually the human.
5. "I don't know" is a valid answer. Record the question as `- Status: assumption` with your proposed answer, and ask the human to approve it. Only the human writes `- Approved: yes`.
6. Do not write plans or code. Do not edit `spec.md`: if the spec is wrong, tell the human. Never edit `state.json` or `audit.md`.

## Loop

1. Run `npx specpilot status`: the task must be in `grill`.
2. Read `specs/<task-id>/spec.md`. If `specs/<task-id>/grill.md` does not exist, create it from SpecPilot's `templates/grill.md` structure.
3. Run `npx specpilot grill checklist <task-id>` to see which checklist items are still uncovered.
4. Take the first uncovered item:
   - Search the code first. If it answers the item, add a fact with a repo citation.
   - Otherwise add `### Q<n>: <question>` with `- Status: open`, ask the human that one question, then record `- Status: answered` and `- Answer: <their words>`, and add the facts that cite `[human:Q<n>]`.
5. After every edit, run `npx specpilot ledger check <task-id>` and fix every error before continuing.
6. Repeat until the checklist is fully covered and every acceptance criterion is cited by at least one fact.
7. Run the `grill-auditor` subagent on the task. If it lists blockers, resolve each one (usually with another question) and run the auditor again.
8. Run `npx specpilot gate <task-id>`. If it fails, fix the reasons it lists; do not work around them.
