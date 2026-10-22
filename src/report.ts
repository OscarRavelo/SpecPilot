import fs from 'fs';
import os from 'os';
import path from 'path';
import { computeCost, inWindow, readPrices, taskMessages, taskWindow, transcriptDir } from './cost';
import { listTasks, loadState } from './state';
import type { HistoryEntry, Phase, TaskState } from './state';
import { readHallucinations } from './verify';

export const REPORT_COLUMNS = ['task', 'phase', 'passed', 'rounds', 'hallucinations', 'cost_eur'] as const;

export const NO_TASKS = 'no tasks found in specs/';

const SPECS_DIR = 'specs';
const NO_COST = '—';

// One task of the report.
export interface ReportRow {
  task: string;
  phase: Phase;
  passed: boolean;
  rounds: number;
  hallucinations: number;
  costEur: number | null; // null when the task has no cost data (shown as —)
}

// 1 + the history entries whose to is red and whose from is not plan.
export function countRounds(history: HistoryEntry[]): number {
  return 1 + history.filter((entry) => entry.to === 'red' && entry.from !== 'plan').length;
}

// The EUR cost as specpilot cost computes it, or null when the task has no cost data: an empty history
// (no window), no transcript folder for the project or no counted message in the window. These are
// checked before the prices are read, so a corrupt prices file or a model with no price still throws
// the same error specpilot cost prints.
function taskCostEur(projectRoot: string, state: TaskState, now: Date): number | null {
  if (state.history.length === 0) return null;
  // os.homedir() already returns $HOME when it is set; reading it here also honours a HOME set in-process.
  const dir = transcriptDir(projectRoot, process.env.HOME || os.homedir());
  if (!fs.existsSync(dir)) return null;

  const messages = inWindow(taskMessages(dir, state.taskId), taskWindow(state, now));
  if (messages.length === 0) return null;
  const { prices, file } = readPrices(projectRoot);
  return computeCost(messages, prices, file).eur;
}

// One row per specs/<task>/ with a state.json, sorted by task. Throws on a corrupt state.json,
// hallucinations.json or prices, or a model with no price.
export function reportRows(projectRoot: string): ReportRow[] {
  const specsDir = path.join(projectRoot, SPECS_DIR);
  const now = new Date();
  const rows: ReportRow[] = [];
  for (const task of listTasks(specsDir)) {
    const taskDir = path.join(specsDir, task);
    if (!fs.existsSync(path.join(taskDir, 'state.json'))) continue;

    // The helpers name the absolute taskDir; the report names the folder from the project root.
    const shown = `${SPECS_DIR}/${task}`;
    let state: TaskState;
    try {
      state = loadState(taskDir, task);
    } catch {
      throw new Error(`Corrupt state.json in ${shown}`);
    }
    let hallucinations: number;
    try {
      hallucinations = readHallucinations(taskDir).length;
    } catch {
      throw new Error(`Corrupt hallucinations.json in ${shown}`);
    }
    rows.push({
      task,
      phase: state.phase,
      passed: state.phase === 'done',
      rounds: countRounds(state.history),
      hallucinations,
      costEur: taskCostEur(projectRoot, state, now),
    });
  }
  return rows;
}

// The lines to print: the header and one tab-separated row per task, or NO_TASKS when rows is empty.
export function formatReport(rows: ReportRow[]): string[] {
  if (rows.length === 0) return [NO_TASKS];
  return [
    REPORT_COLUMNS.join('\t'),
    ...rows.map((row) =>
      [
        row.task,
        row.phase,
        row.passed ? 'yes' : 'no',
        String(row.rounds),
        String(row.hallucinations),
        row.costEur === null ? NO_COST : row.costEur.toFixed(2),
      ].join('\t'),
    ),
  ];
}
