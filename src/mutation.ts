import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { brokenSuites, failsOnAssertion } from './tdd';
import type { JestReport } from './tdd';

// Stryker's mutant statuses, as written in its JSON report.
export type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'NoCoverage'
  | 'CompileError'
  | 'Timeout'
  | 'RuntimeError'
  | 'Ignored'
  | 'Pending';

// One mutant from a Stryker run. The id is SpecPilot's own ("file:line mutator replacement"), not Stryker's.
export interface Mutant {
  id: string;
  file: string;
  line: number;
  mutator: string;
  replacement: string;
  status: MutantStatus;
}

// A targeted bug that code-agent injected for one acceptance criterion, and whether a test caught it.
// testFiles ties it to the tests it ran against; bugs recorded before it was stored have none.
export interface BugRecord {
  ac: string;
  caught: boolean;
  at: string;
  sourceFiles: Record<string, string>;
  testFiles?: Record<string, string>;
  failing: string[];
}

// What specpilot mutate saw: the Stryker mutants and the targeted bugs, with hashes of the code they ran on.
// files is every file mutated so far (sorted); mutation.json written before it was stored has none.
export interface MutationEvidence {
  taskId: string;
  at: string;
  sourceFiles: Record<string, string>;
  testFiles: Record<string, string>;
  files?: string[];
  mutants: Mutant[];
  bugs: BugRecord[];
}

// A surviving mutant in equivalents.md, and whether the human approved it as equivalent.
export interface Equivalent {
  id: string;
  approved: boolean;
  reason: string;
}

const STRYKER = '@stryker-mutator/core';
const INSTALL = 'npm i -D @stryker-mutator/core @stryker-mutator/jest-runner @stryker-mutator/typescript-checker';

// Evidence written before specpilot mutate existed has no source hashes; only tdd red and green write them.
export function missingSourceHashes(taskId: string, stage: 'red' | 'green'): string {
  return (
    `${stage}.json has no source file hashes (it is older than specpilot mutate): go back with specpilot reopen ${taskId} red, ` +
    `then run specpilot tdd red ${taskId} and specpilot tdd green ${taskId}`
  );
}

// Unlike Stryker's ids, this one stays the same between runs, so a human approval keeps pointing at the
// same mutant. Whitespace is collapsed so a multi-line replacement still fits on one "###" line, and an
// empty replacement leaves no trailing space, which equivalents.md would trim away from the heading.
export function mutantId(file: string, line: number, mutator: string, replacement: string): string {
  const code = replacement.replace(/\s+/g, ' ').trim();
  return code ? `${file}:${line} ${mutator} ${code}` : `${file}:${line} ${mutator}`;
}

// The TypeScript checker needs a tsconfig.json; a plain-JS project gets no checker.
export function strykerConfig(files: string[], reportFile: string, root: string): Record<string, unknown> {
  return {
    mutate: files,
    testRunner: 'jest',
    checkers: fs.existsSync(path.join(root, 'tsconfig.json')) ? ['typescript'] : [],
    reporters: ['json', 'clear-text'],
    jsonReporter: { fileName: reportFile },
    coverageAnalysis: 'perTest',
  };
}

// Node's own lookup: node_modules in the root or any folder above it.
function installed(root: string, name: string): boolean {
  let dir = path.resolve(root);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'node_modules', name, 'package.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

// Runs Stryker over the given files and returns its parsed JSON report. Stryker's own output (the
// clear-text table of survivors) goes straight to the terminal.
export function runStryker(root: string, files: string[]): unknown {
  if (!installed(root, STRYKER)) {
    throw new Error(`Stryker is not installed in this project: run ${INSTALL}`);
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-stryker-'));
  const reportFile = path.join(outDir, 'report.json');
  const configFile = path.join(outDir, 'stryker.config.json');
  try {
    fs.writeFileSync(configFile, `${JSON.stringify(strykerConfig(files, reportFile, root), null, 2)}\n`);
    const run = spawnSync('npx', ['stryker', 'run', configFile], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    // A run that failed part way may still have written a report, but it proves nothing.
    if (run.error) throw new Error(`Stryker could not be started: ${run.error.message}`);
    if (run.status !== 0) {
      throw new Error(`Stryker exited with code ${run.status ?? run.signal}: see its output above`);
    }
    if (!fs.existsSync(reportFile)) {
      throw new Error('Stryker did not write a JSON report: see its output above');
    }
    return JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

interface StrykerMutant {
  mutatorName: string;
  replacement?: string;
  status: MutantStatus;
  location: { start: { line: number } };
}

// The report keys files by path, relative to the project or absolute; SpecPilot keys them like its hashes.
export function parseStrykerReport(report: unknown, root: string): Mutant[] {
  const files = (report as { files?: Record<string, { mutants?: StrykerMutant[] }> } | null)?.files;
  if (typeof files !== 'object' || files === null) throw new Error('The Stryker report has no "files"');

  return Object.entries(files).flatMap(([name, { mutants = [] }]) => {
    const file = path.relative(root, path.resolve(root, name)).split(path.sep).join('/');
    return mutants.map((m) => {
      const line = m.location.start.line;
      const replacement = m.replacement ?? '';
      return { id: mutantId(file, line, m.mutatorName, replacement), file, line, mutator: m.mutatorName, replacement, status: m.status };
    });
  });
}

// A mutant that no test is known to have killed: one that survived, had no coverage, never ran
// (Pending), crashed the run (RuntimeError) or was skipped (Ignored). One that did not compile was
// caught by the compiler, not by a test, so it is neither a survivor nor counted as killed.
const SURVIVING: MutantStatus[] = ['Survived', 'NoCoverage', 'Pending', 'RuntimeError', 'Ignored'];

export function survivors(mutants: Mutant[]): Mutant[] {
  return mutants.filter((m) => SURVIVING.includes(m.status));
}

const EQUIVALENT_FIELD = /^-\s+(Approved|Reason):\s*(.*?)\s*$/i;

export function parseEquivalents(text: string): Equivalent[] {
  const equivalents: Equivalent[] = [];
  let current: Equivalent | null = null;
  for (const line of text.split('\n')) {
    const heading = line.match(/^###\s+(.*?)\s*$/);
    if (heading) {
      current = { id: heading[1], approved: false, reason: '' };
      equivalents.push(current);
      continue;
    }
    const field = current ? line.match(EQUIVALENT_FIELD) : null;
    if (!current || !field) continue;
    if (field[1].toLowerCase() === 'approved') current.approved = field[2].toLowerCase() === 'yes';
    else current.reason = field[2];
  }
  return equivalents;
}

// One section per surviving mutant. The human's approvals are kept for mutants that still survive;
// the rest are dropped, so an old approval never covers a new mutant.
export function renderEquivalents(taskId: string, survivors: Mutant[], previous: Equivalent[]): string {
  const ids = [...new Set(survivors.map((m) => m.id))];
  const lines = [
    `# Equivalent mutants: ${taskId}`,
    '',
    'Each surviving mutant is a test gap unless it behaves exactly like the original code.',
    'Only the human approves one, with "- Approved: yes" and a reason. specpilot mutate rewrites this file.',
    '',
  ];
  if (ids.length === 0) lines.push('No surviving mutants.', '');
  for (const id of ids) {
    const kept = previous.find((equivalent) => equivalent.id === id);
    lines.push(`### ${id}`, `- Approved: ${kept?.approved ? 'yes' : 'no'}`, `- Reason: ${kept?.reason ?? ''}`, '');
  }
  return lines.join('\n');
}

export function unapprovedSurvivors(mutants: Mutant[], equivalents: Equivalent[]): Mutant[] {
  const approved = new Set(equivalents.filter((equivalent) => equivalent.approved).map((equivalent) => equivalent.id));
  return survivors(mutants).filter((m) => !approved.has(m.id));
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A targeted bug is caught only if every suite ran (a bug that does not compile proves nothing) and a
// test with the AC in its name, as a whole id, fails on an assertion. AC-1 is not AC-12, AC-1.2, AC-1-x
// or XAC-1, but a sentence may end right after it ("adds AC-1.").
export function bugProblems(report: JestReport, acId: string, root: string): string[] {
  const broken = brokenSuites(report, root);
  if (broken.length > 0) return [...broken, 'A suite that fails to run does not catch a bug'];

  const named = new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(acId)}(?![0-9]|[.-][A-Za-z0-9])`);
  const caught = report.testResults
    .flatMap((suite) => suite.assertionResults)
    .some((test) => test.status === 'failed' && named.test(test.fullName) && failsOnAssertion(test));
  return caught ? [] : [`No test with ${acId} in its name fails on an assertion`];
}

const STATUSES: MutantStatus[] = ['Killed', 'Survived', 'NoCoverage', 'CompileError', 'Timeout', 'RuntimeError', 'Ignored', 'Pending'];

function isMutant(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Partial<Mutant>;
  return (
    typeof m.id === 'string' &&
    typeof m.file === 'string' &&
    typeof m.line === 'number' &&
    typeof m.mutator === 'string' &&
    typeof m.replacement === 'string' &&
    STATUSES.includes(m.status as MutantStatus)
  );
}

function isBugRecord(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const bug = value as Partial<BugRecord>;
  return typeof bug.ac === 'string' && typeof bug.caught === 'boolean' && typeof bug.at === 'string';
}

export function readMutationEvidence(taskDir: string): MutationEvidence | null {
  const file = path.join(taskDir, 'mutation.json');
  if (!fs.existsSync(file)) return null;

  let evidence: Partial<MutationEvidence> | null;
  try {
    evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    evidence = null;
  }
  if (
    !evidence ||
    typeof evidence.taskId !== 'string' ||
    typeof evidence.sourceFiles !== 'object' ||
    evidence.sourceFiles === null ||
    typeof evidence.testFiles !== 'object' ||
    evidence.testFiles === null ||
    !Array.isArray(evidence.mutants) ||
    !evidence.mutants.every(isMutant) ||
    !Array.isArray(evidence.bugs) ||
    !evidence.bugs.every(isBugRecord) ||
    (evidence.files !== undefined && !Array.isArray(evidence.files))
  ) {
    throw new Error(`Corrupt mutation.json in ${taskDir}`);
  }
  return evidence as MutationEvidence;
}

export function writeMutationEvidence(taskDir: string, evidence: MutationEvidence): void {
  fs.writeFileSync(path.join(taskDir, 'mutation.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}
