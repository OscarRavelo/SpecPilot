import type { HistoryEntry, Phase } from './state';

export const REPORT_COLUMNS = ['task', 'phase', 'passed', 'rounds', 'hallucinations', 'cost_eur'] as const;

export const NO_TASKS = 'no tasks found in specs/';

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
  return 0;
}

// One row per specs/<task>/ with a state.json, sorted by task. Throws on a corrupt state.json,
// hallucinations.json or prices, or a model with no price.
export function reportRows(projectRoot: string): ReportRow[] {
  return [];
}

// The lines to print: the header and one tab-separated row per task, or NO_TASKS when rows is empty.
export function formatReport(rows: ReportRow[]): string[] {
  return [];
}
