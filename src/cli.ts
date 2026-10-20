#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { parseSpec, lintSpec } from './spec';
import { listTasks, nextPhase, isBackward, transition, loadState, saveState } from './state';
import type { TaskState } from './state';
import { runGate } from './gates';
import { parseLedger, checkLedger } from './ledger';
import { checklistFor } from './checklist';
import { ledgerHash } from './audit';
import { checkToolUse, stopWarning } from './hooks';
import {
  failingTests,
  fileHashes,
  greenProblems,
  hashChanges,
  passingTests,
  readEvidence,
  redProblems,
  runTests,
  taskSourceFiles,
  testFileHashes,
  writeEvidence,
} from './tdd';
import {
  bugProblems,
  filesMissingFromReport,
  missingSourceHashes,
  nodeVersionProblem,
  parseEquivalents,
  parseStrykerReport,
  readMutationEvidence,
  renderEquivalents,
  runStryker,
  strykerFileProblem,
  strykerMatchProblem,
  survivors,
  unapprovedSurvivors,
  writeMutationEvidence,
} from './mutation';
import type { MutationEvidence } from './mutation';
import { acCoverage, readHallucinations, recordHallucination, verifyProblems } from './verify';
import type { ToolUse } from './hooks';
import type { Evidence, JestReport } from './tdd';

const SPECS_DIR = 'specs';

const HELP = `Usage: specpilot <command> [options]

Commands:
  init                    Install SpecPilot in the current project
  spec lint <file>        Check a spec's format
  ledger check <task>     Check that every fact in the grill ledger cites a real source
  grill checklist <task>  Show which checklist items the grill ledger covers
  grill hash <task>       Print the hash the grill auditor records in audit.md
  hook pre-tool-use [--roles]
                          Claude Code hook: block edits the phase (or, with --roles, the role) does not allow
  hook stop               Claude Code hook: warn when a task cannot be done yet
  status                  Show each task's phase
  gate <task>             Check the current phase and, if it passes, move to the next one
  reopen <task> <phase>   Go back to an allowed earlier phase
  tdd red|green <task>    Run the tests and record red / green evidence
  mutate <task>           Run Stryker over the task's code and record the surviving mutants
  mutate bug <task> AC-n  Run the tests against a bug injected for one AC and record whether it was caught
  verify <task>           Run the tests again and check every AC is covered; if so, move to done
  report                  Summarize cost and quality metrics
`;

const NOT_IMPLEMENTED = ['init', 'report'];

function specLint(file: string | undefined): number {
  if (!file) {
    console.error('Usage: specpilot spec lint <file>');
    return 1;
  }

  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Cannot read ${file}: ${(err as Error).message}`);
    return 1;
  }

  const errors = lintSpec(text);
  if (errors.length === 0) {
    const spec = parseSpec(text);
    const count = spec.acceptanceCriteria.length;
    console.log(`OK: ${spec.id} (${count} acceptance ${count === 1 ? 'criterion' : 'criteria'})`);
    return 0;
  }

  for (const { code, line, message } of errors) {
    console.error(`${file}:${line} ${code} ${message}`);
  }
  console.error(`${errors.length} ${errors.length === 1 ? 'error' : 'errors'}`);
  return 1;
}

function ledgerCheck(taskId: string | undefined): number {
  if (!taskId) {
    console.error('Usage: specpilot ledger check <task>');
    return 1;
  }
  const task = openTask(taskId);
  if (!task) return 1;

  const ledgerFile = path.join(task.taskDir, 'grill.md');
  if (!fs.existsSync(ledgerFile)) {
    console.error(`Missing ${ledgerFile}`);
    return 1;
  }
  const ledgerText = fs.readFileSync(ledgerFile, 'utf8');
  const specText = fs.readFileSync(path.join(task.taskDir, 'spec.md'), 'utf8');

  const errors = checkLedger(ledgerText, specText, process.cwd());
  if (errors.length === 0) {
    const { facts } = parseLedger(ledgerText);
    const citations = facts.reduce((total, fact) => total + fact.citations.length, 0);
    console.log(`OK: ${taskId} ledger (${facts.length} facts, ${citations} citations checked)`);
    return 0;
  }

  for (const { code, line, message } of errors) {
    console.error(`${ledgerFile}:${line} ${code} ${message}`);
  }
  console.error(`${errors.length} ${errors.length === 1 ? 'error' : 'errors'}`);
  return 1;
}

function grillChecklist(taskId: string | undefined): number {
  if (!taskId) {
    console.error('Usage: specpilot grill checklist <task>');
    return 1;
  }
  const task = openTask(taskId);
  if (!task) return 1;

  const { type } = parseSpec(fs.readFileSync(path.join(task.taskDir, 'spec.md'), 'utf8'));
  const checklist = checklistFor(type as string);
  const ledgerFile = path.join(task.taskDir, 'grill.md');
  const facts = fs.existsSync(ledgerFile) ? parseLedger(fs.readFileSync(ledgerFile, 'utf8')).facts : [];
  const covered = new Set(facts.flatMap((fact) => fact.topics));

  const done = checklist.filter((item) => covered.has(item.id)).length;
  console.log(`${taskId} (${type}): ${done}/${checklist.length} covered`);
  for (const item of checklist) {
    console.log(`[${covered.has(item.id) ? 'x' : ' '}] ${item.id}: ${item.description}`);
  }
  return 0;
}

function grillHash(taskId: string | undefined): number {
  if (!taskId) {
    console.error('Usage: specpilot grill hash <task>');
    return 1;
  }
  const task = openTask(taskId);
  if (!task) return 1;

  const ledgerFile = path.join(task.taskDir, 'grill.md');
  if (!fs.existsSync(ledgerFile)) {
    console.error(`Missing ${ledgerFile}`);
    return 1;
  }
  const specText = fs.readFileSync(path.join(task.taskDir, 'spec.md'), 'utf8');
  console.log(ledgerHash(specText, fs.readFileSync(ledgerFile, 'utf8')));
  return 0;
}

function status(): number {
  const tasks = listTasks(SPECS_DIR);
  if (tasks.length === 0) {
    console.log(`No tasks in ${SPECS_DIR}/`);
    return 0;
  }
  for (const taskId of tasks) {
    console.log(`${taskId}  ${loadState(path.join(SPECS_DIR, taskId), taskId).phase}`);
  }
  return 0;
}

function openTask(taskId: string): { taskDir: string; state: TaskState } | null {
  const taskDir = path.join(SPECS_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    console.error(`No task ${taskId} (${taskDir})`);
    return null;
  }
  return { taskDir, state: loadState(taskDir, taskId) };
}

function gate(taskId: string | undefined): number {
  if (!taskId) {
    console.error('Usage: specpilot gate <task>');
    return 1;
  }
  const task = openTask(taskId);
  if (!task) return 1;

  const { taskDir, state } = task;
  const result = runGate(taskDir, state.phase);
  if (!result.ok) {
    console.error(`${taskId} is still in ${state.phase}:`);
    for (const reason of result.reasons) console.error(`  - ${reason}`);
    return 1;
  }

  // runGate never passes in "done", so there is always a next phase here.
  const next = transition(state, nextPhase(state.phase) as string);
  saveState(taskDir, next);
  console.log(`${taskId}: ${state.phase} → ${next.phase}`);
  return 0;
}

function reopen(taskId: string | undefined, phase: string | undefined): number {
  if (!taskId || !phase) {
    console.error('Usage: specpilot reopen <task> <phase>');
    return 1;
  }
  const task = openTask(taskId);
  if (!task) return 1;

  const { taskDir, state } = task;
  if (phase === nextPhase(state.phase)) {
    console.error(`reopen only goes back; to move forward use: specpilot gate ${taskId}`);
    return 1;
  }
  if (!isBackward(state.phase, phase)) {
    console.error(`Cannot move from ${state.phase} to ${phase}`);
    return 1;
  }

  const next = transition(state, phase);
  saveState(taskDir, next);
  console.log(`${taskId}: ${state.phase} → ${next.phase}`);
  return 0;
}

// Exit 2 tells Claude Code to block the tool call and show stderr to the agent.
function hook(event: string | undefined, flags: string[]): number {
  if (event === 'stop') return hookStop();
  if (event !== 'pre-tool-use' || flags.some((flag) => flag !== '--roles')) {
    console.error('Usage: specpilot hook pre-tool-use [--roles] | specpilot hook stop');
    return 1;
  }
  const roles = flags.includes('--roles');

  let input: ToolUse;
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    console.error('Blocked by SpecPilot: Invalid hook input (expected the PreToolUse JSON on stdin)');
    return 2;
  }
  if (!input || typeof input.tool_name !== 'string' || typeof input.tool_input !== 'object' || !input.tool_input) {
    console.error('Blocked by SpecPilot: Invalid hook input (expected the PreToolUse JSON on stdin)');
    return 2;
  }

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const decision = checkToolUse(input, root, process.env.SPECPILOT_TASK || undefined, roles);
  if (decision.allow) return 0;
  console.error(decision.reason);
  return 2;
}

// Never blocks: the warning is shown to the human as a system message and the hook exits 0.
function hookStop(): number {
  // The Stop input is not needed, but it is read so Claude Code never writes to a closed pipe.
  try {
    fs.readFileSync(0);
  } catch {
    // no stdin
  }
  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const warning = stopWarning(root, process.env.SPECPILOT_TASK || undefined);
  if (warning !== null) console.log(JSON.stringify({ systemMessage: warning }));
  return 0;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

// Red: the tests must fail, and only on assertions. Green: they must all pass, unchanged since red.
function tdd(stage: string | undefined, taskId: string | undefined): number {
  if ((stage !== 'red' && stage !== 'green') || !taskId) {
    console.error('Usage: specpilot tdd red|green <task>');
    return 1;
  }
  const task = openTask(taskId);
  if (!task) return 1;

  const { taskDir, state } = task;
  if (state.phase !== stage) {
    console.error(`${taskId} is in ${state.phase}: tdd ${stage} runs only in the ${stage} phase`);
    return 1;
  }
  const root = process.cwd();
  const red = stage === 'green' ? readEvidence(taskDir, 'red') : null;
  if (stage === 'green' && !red) {
    console.error(`Missing red.json: run specpilot tdd red ${taskId} first`);
    return 1;
  }

  const report = runTests(root);
  const testFiles = testFileHashes(root);
  const problems = stage === 'red' ? redProblems(report, root) : greenProblems(report, root);
  if (red) {
    const changes = hashChanges(red.testFiles, testFiles);
    if (changes.length > 0) {
      problems.push(`Tests changed since tdd red (${changes.join(', ')}): go back with specpilot reopen ${taskId} red`);
    }
  }
  if (problems.length > 0) {
    console.error(`${taskId} is not ${stage}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  const tests = stage === 'red' ? failingTests(report) : passingTests(report);
  const sourceFiles = fileHashes(root, 'source');
  writeEvidence(taskDir, stage, { taskId, at: new Date().toISOString(), tests, testFiles, sourceFiles });
  if (stage === 'red') {
    console.log(`RED: ${taskId} (${plural(tests.length, 'failing test')}, all on assertions)`);
    for (const name of tests) console.log(`  ✕ ${name}`);
  } else {
    console.log(`GREEN: ${taskId} (${tests.length} ${tests.length === 1 ? 'test passes' : 'tests pass'}, tests unchanged since red)`);
  }
  console.log(`Next: specpilot gate ${taskId}`);
  return 0;
}

// Mutation: Stryker over the task's code (specpilot mutate <task>) and targeted bugs (specpilot mutate bug <task> AC-n).
function mutate(args: string[]): number {
  const bug = args[0] === 'bug';
  const [taskId, acId] = bug ? args.slice(1) : args;
  if (!taskId || (bug && !acId)) {
    console.error('Usage: specpilot mutate <task> | specpilot mutate bug <task> AC-n');
    return 1;
  }
  const command = bug ? 'specpilot mutate bug' : 'specpilot mutate';
  const task = openMutationTask(taskId, command);
  if (!task) return 1;
  return bug ? mutateBug(task, acId) : mutateRun(task);
}

interface MutationTask {
  taskId: string;
  taskDir: string;
  red: Evidence | null;
  green: Evidence & { sourceFiles: Record<string, string> };
  root: string;
  sourceFiles: Record<string, string>;
  testFiles: Record<string, string>;
}

// Both mutate commands run only in mutation, over the tests tdd green saw.
function openMutationTask(taskId: string, command: string): MutationTask | null {
  const task = openTask(taskId);
  if (!task) return null;

  const { taskDir, state } = task;
  if (state.phase !== 'mutation') {
    console.error(`${taskId} is in ${state.phase}: ${command} runs only in the mutation phase`);
    return null;
  }
  const green = readEvidence(taskDir, 'green');
  if (!green) {
    console.error(`Missing green.json: run specpilot tdd green ${taskId} first`);
    return null;
  }
  if (!green.sourceFiles) {
    console.error(missingSourceHashes(taskId, 'green'));
    return null;
  }
  const root = process.cwd();
  const testFiles = fileHashes(root, 'test');
  const changes = hashChanges(green.testFiles, testFiles);
  if (changes.length > 0) {
    console.error(`Tests changed after tdd green (${changes.join(', ')}): go back with specpilot reopen ${taskId} red`);
    return null;
  }
  return {
    taskId,
    taskDir,
    red: readEvidence(taskDir, 'red'),
    green: green as MutationTask['green'],
    root,
    sourceFiles: fileHashes(root, 'source'),
    testFiles,
  };
}

const emptyMutation = (taskId: string): MutationEvidence => ({
  taskId,
  at: new Date().toISOString(),
  sourceFiles: {},
  testFiles: {},
  mutants: [],
  bugs: [],
});

function mutateRun({ taskId, taskDir, red, green, root, sourceFiles, testFiles }: MutationTask): number {
  const changes = hashChanges(green.sourceFiles, sourceFiles);
  if (changes.length > 0) {
    console.error(
      `Source code differs from tdd green (${changes.join(', ')}): Stryker must run over the code tdd green saw, so remove any injected bug first`,
    );
    return 1;
  }
  if (!red) {
    console.error(`Missing red.json: run specpilot tdd red ${taskId} first`);
    return 1;
  }
  if (!red.sourceFiles) {
    console.error(missingSourceHashes(taskId, 'red'));
    return 1;
  }
  // After a reopen, red and green differ only in the code of that round, so the files mutated before
  // (and those of their mutants, for a mutation.json without a files list) are mutated again.
  const previous = readMutationEvidence(taskDir) ?? emptyMutation(taskId);
  const files = [
    ...new Set([
      ...taskSourceFiles(red, green),
      ...(previous.files ?? []),
      ...previous.mutants.map((m) => m.file),
    ]),
  ]
    .filter((name) => name in sourceFiles)
    .sort();
  if (files.length === 0) {
    console.error(`${taskId} has no task code to mutate: no source file changed between tdd red and tdd green`);
    return 1;
  }
  // Moving or renaming a file changes the code tdd green saw, so the task goes back to red.
  const fileProblem = strykerFileProblem(files);
  if (fileProblem) {
    console.error(`${fileProblem}, then go back with specpilot reopen ${taskId} red`);
    return 1;
  }
  const nodeProblem = nodeVersionProblem(process.versions.node);
  if (nodeProblem) {
    console.error(nodeProblem);
    return 1;
  }

  // A mutate entry that matches nothing only makes Stryker print a warning, so it is caught before the run.
  const matchProblem = strykerMatchProblem(root, files);
  if (matchProblem) {
    console.error(matchProblem);
    return 1;
  }

  const report = runStryker(root, files);
  const mutants = parseStrykerReport(report, root);
  // Stryker leaves a file with nothing to mutate (only types) out of its report. That is fine for some
  // task files, but a report with none of them proves nothing.
  const noMutants = filesMissingFromReport(report, root, files);
  if (noMutants.length === files.length) {
    console.error(`Stryker reported none of the task files (${files.join(', ')}): see its output above`);
    return 1;
  }
  writeMutationEvidence(taskDir, { ...previous, at: new Date().toISOString(), sourceFiles, testFiles, files, noMutants, mutants });
  for (const file of noMutants) console.log(`no mutants: ${file}`);

  const equivalentsFile = path.join(taskDir, 'equivalents.md');
  const approvals = fs.existsSync(equivalentsFile) ? parseEquivalents(fs.readFileSync(equivalentsFile, 'utf8')) : [];
  fs.writeFileSync(equivalentsFile, renderEquivalents(taskId, survivors(mutants), approvals));

  const count = (...statuses: string[]) => mutants.filter((m) => statuses.includes(m.status)).length;
  console.log(
    `MUTATION: ${taskId} (${plural(files.length, 'file')}: ${count('Killed', 'Timeout')} killed, ` +
      `${survivors(mutants).length} survived, ${plural(count('CompileError'), 'compile error')})`,
  );
  const gaps = unapprovedSurvivors(mutants, parseEquivalents(fs.readFileSync(equivalentsFile, 'utf8')));
  if (gaps.length > 0) {
    console.error(`${plural(gaps.length, 'surviving mutant')}, each one a test gap:`);
    for (const mutant of gaps) console.error(`  ✕ ${mutant.id} (${mutant.status})`);
    console.error(`Stop and report the gap, then go back with specpilot reopen ${taskId} red`);
    console.error(`(only the human may approve a mutant as equivalent, in ${equivalentsFile})`);
    return 1;
  }
  console.log(`Next: inject a bug for each AC and run specpilot mutate bug ${taskId} AC-n, then specpilot gate ${taskId}`);
  return 0;
}

// A targeted bug: code-agent breaks the code for one AC, and a test named with that AC must fail on an assertion.
function mutateBug({ taskId, taskDir, green, root, sourceFiles, testFiles }: MutationTask, acId: string): number {
  const { acceptanceCriteria } = parseSpec(fs.readFileSync(path.join(taskDir, 'spec.md'), 'utf8'));
  if (!acceptanceCriteria.some((ac) => ac.id === acId)) {
    const known = acceptanceCriteria.map((ac) => ac.id).join(', ');
    console.error(`${acId} is not an acceptance criterion of ${taskId} (it has ${known || 'none'})`);
    return 1;
  }
  if (hashChanges(green.sourceFiles, sourceFiles).length === 0) {
    console.error(`No bug injected: the source code is identical to tdd green. Inject a bug for ${acId} first`);
    return 1;
  }

  const report = runTests(root);
  const problems = bugProblems(report, acId, root);
  const failing = failingTests(report);
  const previous = readMutationEvidence(taskDir) ?? emptyMutation(taskId);
  const record = { ac: acId, caught: problems.length === 0, at: new Date().toISOString(), sourceFiles, testFiles, failing };
  writeMutationEvidence(taskDir, { ...previous, bugs: [...previous.bugs, record] });

  if (problems.length > 0) {
    console.error(`NOT CAUGHT: the bug for ${acId} in ${taskId} is a test gap:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`Remove the bug, stop and report the gap, then go back with specpilot reopen ${taskId} red`);
    return 1;
  }
  console.log(`CAUGHT: the bug for ${acId} in ${taskId} (${plural(failing.length, 'failing test')})`);
  for (const name of failing) console.log(`  ✕ ${name}`);
  console.log(`Now remove the bug: the code must be exactly what tdd green saw before specpilot gate ${taskId}`);
  return 0;
}

// Verify: the mutation gate again, a fresh test run and a passing test for every AC. A blocked run is
// recorded as a hallucination. Exit 2 means verify could not run, and nothing is recorded.
function verify(taskId: string | undefined): number {
  if (!taskId) {
    console.error('Usage: specpilot verify <task>');
    return 2;
  }
  // Unlike the other commands, a corrupt or unreadable state.json means verify could not run.
  let task: ReturnType<typeof openTask>;
  try {
    task = openTask(taskId);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }
  if (!task) return 2;

  const { taskDir, state } = task;
  if (state.phase !== 'verify') {
    console.error(`${taskId} is in ${state.phase}: specpilot verify runs only in the verify phase`);
    return 2;
  }
  const specFile = path.join(taskDir, 'spec.md');
  let specText: string;
  try {
    specText = fs.readFileSync(specFile, 'utf8');
  } catch (err) {
    console.error(`Cannot read ${specFile}: ${(err as Error).message}`);
    return 2;
  }
  const spec = parseSpec(specText);

  // A corrupt hallucinations.json could not record a blocked run, so it is caught before the tests run.
  try {
    readHallucinations(taskDir);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  const root = process.cwd();
  let report: JestReport;
  try {
    report = runTests(root);
  } catch (err) {
    console.error((err as Error).message);
    return 2;
  }

  const problems = verifyProblems(taskDir, root, report, spec);
  if (problems.length > 0) {
    const file = [SPECS_DIR, taskId, 'hallucinations.json'].join('/');
    // A blocked run that cannot be recorded means verify could not run.
    try {
      recordHallucination(taskDir, { taskId, at: new Date().toISOString(), phase: 'verify', reasons: problems });
    } catch (err) {
      console.error(`Cannot write ${file}: ${(err as Error).message}`);
      return 2;
    }
    console.error(`VERIFY: ${taskId} blocked, recorded as a hallucination in ${file}`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`Go back with specpilot reopen ${taskId} red`);
    return 1;
  }

  const acIds = spec.acceptanceCriteria.map((ac) => ac.id);
  const coverage = acCoverage(report, acIds);
  for (const acId of acIds) console.log(`  ✓ ${acId} (${plural(coverage[acId].length, 'test')})`);
  console.log(`VERIFY: ${taskId} passed`);
  const next = transition(state, 'done');
  saveState(taskDir, next);
  console.log(`${taskId}: ${state.phase} → ${next.phase}`);
  return 0;
}

function main([command, ...args]: string[]): number {
  if (command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }
  if (!command) {
    console.log(HELP);
    return 1;
  }
  if (command === 'spec' && args[0] === 'lint') return specLint(args[1]);
  if (command === 'ledger' && args[0] === 'check') return ledgerCheck(args[1]);
  if (command === 'grill' && args[0] === 'checklist') return grillChecklist(args[1]);
  if (command === 'grill' && args[0] === 'hash') return grillHash(args[1]);
  if (command === 'hook') return hook(args[0], args.slice(1));
  if (command === 'tdd') return tdd(args[0], args[1]);
  if (command === 'status') return status();
  if (command === 'gate') return gate(args[0]);
  if (command === 'reopen') return reopen(args[0], args[1]);
  if (command === 'mutate') return mutate(args);
  if (command === 'verify') return verify(args[0]);
  if (NOT_IMPLEMENTED.includes(command)) {
    console.error(`"${command}" is not implemented yet`);
    return 1;
  }
  console.error(`Unknown command: ${command}`);
  return 1;
}

// Expected failures (e.g. a corrupt state.json) are reported as a single line, not a stack trace.
try {
  process.exitCode = main(process.argv.slice(2));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
}
