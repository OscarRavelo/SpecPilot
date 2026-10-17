#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { parseSpec, lintSpec } = require('../src/spec');
const { listTasks, nextPhase, isBackward, transition, loadState, saveState } = require('../src/state');
const { runGate } = require('../src/gates');

const SPECS_DIR = 'specs';

const HELP = `Usage: specpilot <command> [options]

Commands:
  init                    Install SpecPilot in the current project
  spec lint <file>        Check a spec's format
  status                  Show each task's phase
  gate <task>             Check the current phase and, if it passes, move to the next one
  reopen <task> <phase>   Go back to an allowed earlier phase
  tdd red|green           Record red / green evidence
  mutate                  Inject bugs and check that the tests fail
  verify                  Verify the task against its spec
  report                  Summarize cost and quality metrics
`;

const NOT_IMPLEMENTED = ['init', 'tdd', 'mutate', 'verify', 'report'];

function specLint(file) {
  if (!file) {
    console.error('Usage: specpilot spec lint <file>');
    return 1;
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`Cannot read ${file}: ${err.message}`);
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

function status() {
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

function openTask(taskId) {
  const taskDir = path.join(SPECS_DIR, taskId);
  if (!fs.existsSync(taskDir)) {
    console.error(`No task ${taskId} (${taskDir})`);
    return null;
  }
  return { taskDir, state: loadState(taskDir, taskId) };
}

function gate(taskId) {
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

  const next = transition(state, nextPhase(state.phase));
  saveState(taskDir, next);
  console.log(`${taskId}: ${state.phase} → ${next.phase}`);
  return 0;
}

function reopen(taskId, phase) {
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

function main([command, ...args]) {
  if (command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }
  if (!command) {
    console.log(HELP);
    return 1;
  }
  if (command === 'spec' && args[0] === 'lint') return specLint(args[1]);
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
  console.error(err.message);
  process.exitCode = 1;
}
