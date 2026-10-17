const fs = require('fs');
const path = require('path');

const PHASES = ['research', 'grill', 'plan', 'red', 'green', 'mutation', 'verify', 'done'];

// The only allowed backward moves: a new ambiguity found while planning, or tests that miss injected bugs.
const BACKWARD = {
  plan: ['grill'],
  mutation: ['red'],
  verify: ['red'],
};

function assertPhase(phase) {
  if (!PHASES.includes(phase)) throw new Error(`Unknown phase: ${phase}`);
}

function createState(taskId) {
  return { taskId, phase: 'research', history: [] };
}

function nextPhase(phase) {
  assertPhase(phase);
  return PHASES[PHASES.indexOf(phase) + 1] || null;
}

function isBackward(from, to) {
  return (BACKWARD[from] || []).includes(to);
}

function transition(state, to, now = new Date()) {
  assertPhase(to);
  const from = state.phase;
  if (nextPhase(from) !== to && !isBackward(from, to)) {
    throw new Error(`Cannot move from ${from} to ${to}`);
  }
  return {
    ...state,
    phase: to,
    history: [...state.history, { from, to, at: now.toISOString() }],
  };
}

function loadState(taskDir, taskId) {
  const file = path.join(taskDir, 'state.json');
  if (!fs.existsSync(file)) return createState(taskId);

  let state;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    state = null;
  }
  if (
    !state ||
    state.taskId !== taskId ||
    !PHASES.includes(state.phase) ||
    !Array.isArray(state.history)
  ) {
    throw new Error(`Corrupt state.json in ${taskDir}`);
  }
  return state;
}

// Task ids are the folder names under specs/, sorted so output does not depend on the file system.
function listTasks(specsDir) {
  if (!fs.existsSync(specsDir)) return [];
  return fs
    .readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function saveState(taskDir, state) {
  fs.writeFileSync(path.join(taskDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}

module.exports = {
  PHASES,
  listTasks,
  createState,
  nextPhase,
  isBackward,
  transition,
  loadState,
  saveState,
};
