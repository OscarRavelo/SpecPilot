import fs from 'fs';
import path from 'path';

export const PHASES = ['research', 'grill', 'plan', 'red', 'green', 'mutation', 'verify', 'done'] as const;

export type Phase = (typeof PHASES)[number];

export interface HistoryEntry {
  from: Phase;
  to: Phase;
  at: string;
}

export interface TaskState {
  taskId: string;
  phase: Phase;
  history: HistoryEntry[];
}

// The only allowed backward moves: a new ambiguity found while planning, or tests that miss injected bugs.
const BACKWARD: Partial<Record<Phase, Phase[]>> = {
  plan: ['grill'],
  mutation: ['red'],
  verify: ['red'],
};

function isPhase(phase: unknown): phase is Phase {
  return (PHASES as readonly unknown[]).includes(phase);
}

function assertPhase(phase: string): asserts phase is Phase {
  if (!isPhase(phase)) throw new Error(`Unknown phase: ${phase}`);
}

export function createState(taskId: string): TaskState {
  return { taskId, phase: 'research', history: [] };
}

export function nextPhase(phase: string): Phase | null {
  assertPhase(phase);
  return PHASES[PHASES.indexOf(phase) + 1] || null;
}

export function isBackward(from: Phase, to: string): boolean {
  return (BACKWARD[from] || []).includes(to as Phase);
}

export function transition(state: TaskState, to: string, now: Date = new Date()): TaskState {
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

export function loadState(taskDir: string, taskId: string): TaskState {
  const file = path.join(taskDir, 'state.json');
  if (!fs.existsSync(file)) return createState(taskId);

  let state: Partial<TaskState> | null;
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    state = null;
  }
  if (
    !state ||
    state.taskId !== taskId ||
    !isPhase(state.phase) ||
    !Array.isArray(state.history)
  ) {
    throw new Error(`Corrupt state.json in ${taskDir}`);
  }
  return state as TaskState;
}

// Task ids are the folder names under specs/, sorted so output does not depend on the file system.
export function listTasks(specsDir: string): string[] {
  if (!fs.existsSync(specsDir)) return [];
  return fs
    .readdirSync(specsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function saveState(taskDir: string, state: TaskState): void {
  fs.writeFileSync(path.join(taskDir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`);
}
