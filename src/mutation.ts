import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { createRequire } from 'module';
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
// noMutants is the task files Stryker left out of its report (sorted), such as a file with only types.
export interface MutationEvidence {
  taskId: string;
  at: string;
  sourceFiles: Record<string, string>;
  testFiles: Record<string, string>;
  files?: string[];
  noMutants?: string[];
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
export const INSTALL ='npm i -D @stryker-mutator/core @stryker-mutator/jest-runner @stryker-mutator/typescript-checker';

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

// A glob matching exactly one file. Stryker turns every backslash in the pattern into "/" before
// matching, so glob characters are escaped as character classes ("[*]", "[[]") instead. "!" is not
// escaped: disableTypeChecks resolves the pattern to an absolute path, so it never starts with "!".
// Stryker checks a mutate entry for a leading "!" before resolving it, so a root-level file whose
// name starts with "!" becomes an exclude and is never mutated (a known limit).
const exactFileGlob = (file: string) => file.replace(/[*?()[\]]/g, '[$&]');

// A glob matching exactly the given files; several files become a {a,b} list.
function exactGlob(files: string[]): string {
  const escaped = files.map(exactFileGlob);
  return escaped.length === 1 ? escaped[0] : `{${escaped.join(',')}}`;
}

// Why Stryker cannot mutate one of the given files, or null if it can mutate them all. "{", "}" and ","
// cannot be escaped inside a {a,b} list, so a file with them in its path has to be renamed. Stryker
// matches mutate entries with dot: false and never lists hidden files or folders, so it would mutate
// nothing under a path segment that starts with ".".
export function strykerFileProblem(files: string[]): string | null {
  const unmatchable = files.find((file) => /[{},]/.test(file));
  if (unmatchable !== undefined) {
    return `${unmatchable} cannot be matched exactly by a Stryker glob: rename it without "{", "}" or ","`;
  }
  const hidden = files.find((file) => file.split('/').some((segment) => segment.startsWith('.')));
  if (hidden !== undefined) {
    return `${hidden} is hidden (a path segment starts with "."), and Stryker skips hidden files and folders: move or rename it`;
  }
  return null;
}

type Minimatch = (file: string, pattern: string, options: { dot: boolean }) => boolean;

// Stryker's FileMatcher is ESM and not exported, so its rule is applied here with the minimatch Stryker
// itself loads. Older minimatch versions export the function itself instead of { minimatch }.
function strykerMinimatch(root: string): Minimatch {
  const manifest = installedManifest(root, STRYKER);
  if (!manifest) throw new Error(`Stryker is not installed in this project: run ${INSTALL}`);
  const loaded = createRequire(manifest)('minimatch') as Minimatch | { minimatch: Minimatch };
  return typeof loaded === 'function' ? loaded : loaded.minimatch;
}

// Why Stryker would skip one of the given files, or null if each mutate entry matches its file. Stryker
// matches each entry with new FileMatcher(entry, false): the entry and the file are both resolved against
// the project root, backslashes become "/", and minimatch runs with dot: false. The root is not escaped,
// so a glob character in it (such as "[x]" in a folder above the files) makes the entry match nothing.
// The root is only blamed when it holds such a character; otherwise the mismatch has another cause.
export function strykerMatchProblem(root: string, files: string[]): string | null {
  const minimatch = strykerMinimatch(root);
  const resolved = (name: string) => path.resolve(root, name).replace(/\\/g, '/');
  for (const file of files) {
    const entry = exactFileGlob(file);
    if (!minimatch(resolved(file), resolved(entry), { dot: false })) {
      const problem = `Stryker would skip ${file}: its mutate entry ${entry} does not match it`;
      if (!/[*?[\]{}(),!]/.test(root)) return problem;
      return (
        `${problem}, because Stryker reads the project root ${root} as a glob: move the project to a ` +
        'path without glob characters'
      );
    }
  }
  return null;
}

// The report keys files like parseStrykerReport reads them; a file with nothing to mutate (only types)
// is left out of it.
export function filesMissingFromReport(report: unknown, root: string, files: string[]): string[] {
  const reported = (report as { files?: Record<string, unknown> } | null)?.files ?? {};
  const keys = new Set(Object.keys(reported).map((name) => path.relative(root, path.resolve(root, name)).split(path.sep).join('/')));
  return files.filter((file) => !keys.has(file));
}

// The TypeScript checker needs a tsconfig.json; a plain-JS project gets no checker.
export function strykerConfig(files: string[], reportFile: string, root: string): Record<string, unknown> {
  const problem = strykerFileProblem(files);
  if (problem) throw new Error(problem);
  return {
    // Stryker matches each entry on its own as a glob, so each one is escaped to match only its file.
    mutate: files.map(exactFileGlob),
    // Stryker adds // @ts-nocheck to every file this matches. Its default matches test/ too, which
    // shifts the line numbers of fixtures that tests read; only the mutated files may get it.
    disableTypeChecks: exactGlob(files),
    testRunner: 'jest',
    checkers: fs.existsSync(path.join(root, 'tsconfig.json')) ? ['typescript'] : [],
    reporters: ['json', 'clear-text'],
    jsonReporter: { fileName: reportFile },
    coverageAnalysis: 'perTest',
  };
}

// Node's own lookup: node_modules in the root or any folder above it. Returns the package.json found, or null.
function installedManifest(root: string, name: string): string | null {
  let dir = path.resolve(root);
  for (;;) {
    const manifest = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(manifest)) return manifest;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Stryker needs Node >= 22; returns why the given version is too old, or null if it is fine.
export function nodeVersionProblem(version: string): string | null {
  const major = Number.parseInt(version.replace(/^v/, ''), 10);
  if (major >= 22) return null;
  return `Stryker needs Node >= 22, but this is Node ${version}: upgrade Node and run specpilot mutate again`;
}

// Runs Stryker over the given files and returns its parsed JSON report. Stryker's own output (the
// clear-text table of survivors) goes straight to the terminal.
export function runStryker(root: string, files: string[]): unknown {
  if (!installedManifest(root, STRYKER)) {
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

// A test name names an AC only as a whole id. AC-1 is not AC-12, AC-1x, AC-1.2, AC-1-x or XAC-1, but a
// sentence may end right after it ("adds AC-1.").
export function namesAc(testName: string, acId: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(acId)}(?![A-Za-z0-9]|[.-][A-Za-z0-9])`).test(testName);
}

// A targeted bug is caught only if every suite ran (a bug that does not compile proves nothing) and a
// test that names the AC fails on an assertion.
export function bugProblems(report: JestReport, acId: string, root: string): string[] {
  const broken = brokenSuites(report, root);
  if (broken.length > 0) return [...broken, 'A suite that fails to run does not catch a bug'];

  const caught = report.testResults
    .flatMap((suite) => suite.assertionResults)
    .some((test) => test.status === 'failed' && namesAc(test.fullName, acId) && failsOnAssertion(test));
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
    (evidence.files !== undefined && !Array.isArray(evidence.files)) ||
    (evidence.noMutants !== undefined && !Array.isArray(evidence.noMutants))
  ) {
    throw new Error(`Corrupt mutation.json in ${taskDir}`);
  }
  return evidence as MutationEvidence;
}

export function writeMutationEvidence(taskDir: string, evidence: MutationEvidence): void {
  fs.writeFileSync(path.join(taskDir, 'mutation.json'), `${JSON.stringify(evidence, null, 2)}\n`);
}
