import fs from 'fs';
import path from 'path';
import { parseSpec } from './spec';
import type { Spec } from './spec';
import { runGate } from './gates';
import { namesAc } from './mutation';
import { greenProblems, passingTests } from './tdd';
import type { JestReport } from './tdd';

// One blocked specpilot verify run, appended to specs/<task>/hallucinations.json.
export interface Hallucination {
  taskId: string;
  at: string;
  phase: 'verify';
  reasons: string[];
}

const HALLUCINATIONS_FILE = 'hallucinations.json';

// For each AC id, the full names of the passing tests that name it.
export function acCoverage(report: JestReport, acIds: string[]): Record<string, string[]> {
  const passing = passingTests(report);
  return Object.fromEntries(acIds.map((acId) => [acId, passing.filter((name) => namesAc(name, acId))]));
}

// Every reason the task in verify is not done: the mutation gate, the fresh test run and AC coverage.
// A spec with no acceptance criteria has nothing to verify, so it blocks too. The spec is read from
// spec.md unless the caller already parsed it.
export function verifyProblems(
  taskDir: string,
  root: string,
  report: JestReport,
  spec: Spec = parseSpec(fs.readFileSync(path.join(taskDir, 'spec.md'), 'utf8')),
): string[] {
  const mutation = runGate(taskDir, 'mutation', root);
  const { acceptanceCriteria } = spec;
  const coverage = acCoverage(report, acceptanceCriteria.map((ac) => ac.id));
  const uncovered = acceptanceCriteria
    .filter((ac) => coverage[ac.id].length === 0)
    .map((ac) => `${ac.id} has no test that covers it`);
  const noCriteria = acceptanceCriteria.length === 0 ? ['The spec has no acceptance criteria'] : [];
  return [...mutation.reasons, ...greenProblems(report, root), ...noCriteria, ...uncovered];
}

export function recordHallucination(taskDir: string, entry: Hallucination): void {
  const entries = [...readHallucinations(taskDir), entry];
  fs.writeFileSync(path.join(taskDir, HALLUCINATIONS_FILE), `${JSON.stringify(entries, null, 2)}\n`);
}

export function readHallucinations(taskDir: string): Hallucination[] {
  const file = path.join(taskDir, HALLUCINATIONS_FILE);
  if (!fs.existsSync(file)) return [];

  let entries: unknown;
  try {
    entries = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    entries = null;
  }
  if (!Array.isArray(entries)) throw new Error(`Corrupt ${HALLUCINATIONS_FILE} in ${taskDir}`);
  return entries as Hallucination[];
}
