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
import type { ToolUse } from './hooks';

const SPECS_DIR = 'specs';

const HELP = `Usage: specpilot <command> [options]

Commands:
  init                    Install SpecPilot in the current project
  spec lint <file>        Check a spec's format
  ledger check <task>     Check that every fact in the grill ledger cites a real source
  grill checklist <task>  Show which checklist items the grill ledger covers
  grill hash <task>       Print the hash the grill auditor records in audit.md
  hook pre-tool-use       Claude Code hook: block edits the current phase does not allow
  hook stop               Claude Code hook: warn when a task cannot be done yet
  status                  Show each task's phase
  gate <task>             Check the current phase and, if it passes, move to the next one
  reopen <task> <phase>   Go back to an allowed earlier phase
  tdd red|green           Record red / green evidence
  mutate                  Inject bugs and check that the tests fail
  verify                  Verify the task against its spec
  report                  Summarize cost and quality metrics
`;

const NOT_IMPLEMENTED = ['init', 'tdd', 'mutate', 'verify', 'report'];

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
function hook(event: string | undefined): number {
  if (event === 'stop') return hookStop();
  if (event !== 'pre-tool-use') {
    console.error('Usage: specpilot hook pre-tool-use|stop');
    return 1;
  }

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
  const decision = checkToolUse(input, root, process.env.SPECPILOT_TASK || undefined);
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
  if (command === 'hook') return hook(args[0]);
  if (command === 'status') return status();
  if (command === 'gate') return gate(args[0]);
  if (command === 'reopen') return reopen(args[0], args[1]);
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
