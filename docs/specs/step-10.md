---
id: step-10
type: cli-command
---
# `specpilot init` (roadmap step 10)

`specpilot init` installs SpecPilot's Claude Code files into the current project. Running it again changes nothing. This step also adds the `cli-command` task type, so SpecPilot's own specs in `docs/specs/` pass `spec lint`.

## Definitions

- **Project root**: the current working directory. It must hold a `package.json`.
- **Templates**: the `templates/` folder shipped with SpecPilot, found from `dist/` as `path.join(__dirname, '..', 'templates')`.
- **Installed files**: `.claude/settings.json`, `.claude/skills/sp-grill/SKILL.md` and `.claude/agents/grill-auditor.md`, copied from `templates/.claude/`.
- **SpecPilot pre-tool-use hook**: a hook in a `hooks.PreToolUse` group of settings.json whose `command` contains `specpilot hook pre-tool-use`, with or without `--roles`.
- **SpecPilot stop hook**: a hook in a `hooks.Stop` group whose `command` contains `specpilot hook stop`.
- **Package list**: the keys of `dependencies` and `devDependencies` in `package.json`.
- **Stryker packages**: `@stryker-mutator/core`, `@stryker-mutator/jest-runner` and `@stryker-mutator/typescript-checker`.
- **Task types**: `TASK_TYPES` in `src/spec.ts`, in this order: `new-endpoint`, `endpoint-fields`, `react-component`, `cli-command`.
- **cli-command checklist** (what the grill must pin down for a CLI command), in this order:
  - `contract`: command, arguments and options, stdout, stderr and exit codes;
  - `files`: which files it reads and writes, and which must never change;
  - `errors`: every failure, with its exit code and message;
  - `compatibility`: existing commands, options and files keep working;
  - `edge-cases`: missing, empty, corrupt and repeated inputs;
  - `out-of-scope`: what this task must not touch.
- **docs/specs/ holds only specs**: the step 9 mutation results (`docs/specs/step-9-mutation.md`, a report with no frontmatter or ACs) move to `docs/mutation/step-9.md`, and its link to the spec is fixed.

## Out of scope

- Installing `tests-agent` / `code-agent` or turning on `--roles` (roles stay off by default).
- Installing npm packages. `init` only warns about missing ones.
- Widening the matcher of a SpecPilot hook the project already has.
- Publishing to npm.

## Acceptance criteria

### AC-1: Installs into a Node + TypeScript project
- Given a copy of the node-ts fixture (package.json with jest and typescript, tsconfig.json, src/index.ts) and no .claude folder
- When I run specpilot init
- Then the command exits 0
- And .claude/settings.json, .claude/skills/sp-grill/SKILL.md and .claude/agents/grill-auditor.md are byte for byte equal to their templates
- And stdout has one line "created <path>" for each of the 3 files
- And no file of the fixture changes

### AC-2: Installs into a React + TypeScript project
- Given a copy of the react-ts fixture (package.json with react, jest and typescript, tsconfig.json, src/App.tsx) and no .claude folder
- When I run specpilot init
- Then the command exits 0
- And the 3 installed files are byte for byte equal to their templates
- And no file of the fixture changes

### AC-3: Running it twice changes nothing
- Given a project where specpilot init already ran
- When I run specpilot init again
- Then the command exits 0
- And every file in the project has the same bytes and the same mtime as before
- And stdout includes "SpecPilot is already installed: nothing changed."
- And stdout has no "created", "updated" or "kept" line

### AC-4: Merges an existing settings.json
- Given .claude/settings.json with {"permissions": {"allow": ["Bash(ls)"]}} and a PreToolUse group with matcher "Write" running "./lint.sh"
- When I run specpilot init
- Then settings.json keeps the permissions and the "./lint.sh" group unchanged and in first place
- And it gains the template's PreToolUse group and Stop group after the existing groups
- And it is written as JSON indented with 2 spaces and a final newline
- And stdout has the line "updated .claude/settings.json (added SpecPilot hooks)"
- And given a PreToolUse group that already runs "npx specpilot hook pre-tool-use --roles", no PreToolUse group is added, and only the Stop group is added
- And given settings.json already has a SpecPilot pre-tool-use hook and a SpecPilot stop hook, the file keeps every byte
- And running specpilot init a second time after the merge keeps every byte of settings.json

### AC-5: A corrupt settings.json stops init before any write
- Given a .claude/settings.json that is not valid JSON, or whose root is not an object (null, an array, a number), or whose hooks is not an object, or whose hooks.PreToolUse or hooks.Stop is not an array
- When I run specpilot init
- Then the command exits 1 with one line on stderr naming .claude/settings.json
- And settings.json keeps every byte
- And .claude/skills/sp-grill/SKILL.md and .claude/agents/grill-auditor.md are not created

### AC-6: A changed template file is kept and reported
- Given .claude/agents/grill-auditor.md exists with content that differs from its template
- When I run specpilot init
- Then the command exits 0
- And grill-auditor.md keeps every byte
- And stdout has the line "kept .claude/agents/grill-auditor.md (differs from the template)"
- And the other 2 files are created
- And given grill-auditor.md is byte for byte equal to its template, no line names it

### AC-7: Needs a package.json
- Given a folder with no package.json
- When I run specpilot init
- Then the command exits 1 with one line on stderr saying package.json is missing and init must run at the project root
- And no file or folder is created
- And given a package.json that is not valid JSON or whose root is not an object, the command exits 1 with one line naming package.json, and no file or folder is created

### AC-8: Warns about missing packages
- Given a package list without jest
- When I run specpilot init
- Then stdout has a warning naming jest
- And given a package list without one of the Stryker packages, stdout has a warning with the command "npm i -D @stryker-mutator/core @stryker-mutator/jest-runner @stryker-mutator/typescript-checker"
- And given a package list without specpilot, stdout has the warning "specpilot is not installed: the hooks run npx --no specpilot and block every edit until specpilot is installed (see the README: install it from a npm pack tarball)"
- And no warning suggests npm i -D specpilot, since SpecPilot is not on npm and that would install an unrelated package
- And given a package list with jest, every Stryker package and specpilot (in dependencies or devDependencies), stdout has no warning
- And the warnings never change the exit code 0

### AC-9: The installed pre-tool-use hook fails closed
- Given the PreToolUse command of templates/.claude/settings.json and the Stop command
- Then the PreToolUse group's matcher is Bash, Edit, MultiEdit, NotebookEdit and Write
- And the PreToolUse command runs "npx --no specpilot hook pre-tool-use" and the Stop command is "npx --no specpilot hook stop"
- When the PreToolUse command runs in a project whose node_modules/.bin/specpilot exits 0
- Then it exits 0
- And when that specpilot exits 2 with a reason on stderr, the command exits 2 and the reason is on stderr
- And when that specpilot exits 1, or the project has no specpilot, the command exits 2 and stderr has "Blocked by SpecPilot" and "STOP" and "one question at a time"

### AC-10: Works from the packed npm package
- Given the tarball made by npm pack from this repo
- Then it lists package/templates/.claude/settings.json, package/templates/.claude/skills/sp-grill/SKILL.md and package/templates/.claude/agents/grill-auditor.md
- When I install the tarball with npm install --offline into a temp project whose package.json has no dependencies (so nothing is downloaded), and run npx --no specpilot init there
- Then the command exits 0
- And the 3 installed files are byte for byte equal to the templates in the tarball
- And stdout has no warning about specpilot

### AC-11: cli-command is a task type and every spec in docs/specs/ passes spec lint
- Given TASK_TYPES in src/spec.ts
- Then it is ["new-endpoint", "endpoint-fields", "react-component", "cli-command"]
- And a spec with type cli-command passes spec lint
- And a spec with an unknown type gets SPEC_INVALID_TYPE with the message "Use: new-endpoint, endpoint-fields, react-component, cli-command"
- When I run specpilot spec lint on every docs/specs/*.md, including step-9.md and step-10.md
- Then each one exits 0
- And a test lists docs/specs/*.md, fails if the list is empty, and fails naming the file and the lint errors of any spec that does not pass

### AC-12: cli-command has its own grill checklist
- Given a task of type cli-command
- When I run specpilot grill checklist <task>
- Then the items are contract, files, errors, compatibility, edge-cases and out-of-scope, in that order, each with its description from the definition above
- And the grill gate requires a cited fact for each of them, as for the other task types
