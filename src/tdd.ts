import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { classifyPath } from './hooks';

// The parts of Jest's --json report that SpecPilot reads.
export interface JestAssertion {
  fullName: string;
  status: string;
  failureMessages: string[];
  failureDetails: unknown[];
}

export interface JestSuite {
  name: string;
  status: string;
  message: string;
  assertionResults: JestAssertion[];
}

export interface JestReport {
  numTotalTests: number;
  numFailedTests: number;
  testResults: JestSuite[];
}

// What tdd red / tdd green saw: the failing (red) or passing (green) tests and a hash of every test file.
export interface Evidence {
  taskId: string;
  at: string;
  tests: string[];
  testFiles: Record<string, string>;
}

export type Stage = 'red' | 'green';

const SKIPPED_DIRS = ['node_modules', '.git', 'dist', 'build', 'coverage'];

const firstLine = (text: string) => text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';

// A suite that failed to run has no test results, only a message such as "Test suite failed to run".
function brokenSuites(report: JestReport, root: string): string[] {
  return report.testResults
    .filter((suite) => suite.status === 'failed' && suite.assertionResults.length === 0)
    .map((suite) => {
      const reason = firstLine(suite.message.replace(/●\s*Test suite failed to run/, ''));
      const file = path.relative(root, suite.name).split(path.sep).join('/');
      return `${file} failed to run: ${reason}`;
    });
}

const allTests = (report: JestReport) => report.testResults.flatMap((suite) => suite.assertionResults);

// Jest sets matcherResult only when an expect() assertion failed; a thrown error has none.
const failsOnAssertion = (test: JestAssertion) =>
  test.failureDetails.length > 0 &&
  test.failureDetails.every((detail) => typeof detail === 'object' && detail !== null && 'matcherResult' in detail);

export function failingTests(report: JestReport): string[] {
  return allTests(report)
    .filter((test) => test.status === 'failed')
    .map((test) => test.fullName);
}

export function passingTests(report: JestReport): string[] {
  return allTests(report)
    .filter((test) => test.status === 'passed')
    .map((test) => test.fullName);
}

export function redProblems(report: JestReport, root: string): string[] {
  const broken = brokenSuites(report, root);
  const failed = allTests(report).filter((test) => test.status === 'failed');
  if (failed.length === 0 && broken.length === 0) {
    return ['No test fails: red needs at least one test that fails on an assertion'];
  }
  const errors = failed
    .filter((test) => !failsOnAssertion(test))
    .map((test) => `"${test.fullName}" fails with an error, not an assertion: ${firstLine(test.failureMessages[0] ?? '')}`);
  return [...broken, ...errors];
}

export function greenProblems(report: JestReport, root: string): string[] {
  const broken = brokenSuites(report, root);
  const failed = failingTests(report).map((name) => `"${name}" still fails`);
  if (broken.length === 0 && failed.length === 0 && report.numTotalTests === 0) return ['No tests ran'];
  return [...broken, ...failed];
}

// Every test file in the project, keyed by its path relative to the root (sorted, forward slashes).
export function testFileHashes(root: string): Record<string, string> {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const file = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.includes(entry.name)) walk(file);
      } else if (entry.isFile() && classifyPath(file) === 'test') {
        files.push(file);
      }
    }
  };
  walk('');
  files.sort();
  return Object.fromEntries(
    files.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]),
  );
}

export function hashChanges(before: Record<string, string>, after: Record<string, string>): string[] {
  const changed = Object.keys(before).filter((file) => file in after && before[file] !== after[file]);
  const added = Object.keys(after).filter((file) => !(file in before));
  const removed = Object.keys(before).filter((file) => !(file in after));
  return [...changed.map((f) => `changed ${f}`), ...added.map((f) => `added ${f}`), ...removed.map((f) => `removed ${f}`)];
}

// Runs the project's own test script, so build steps in "npm test" still happen. The script must end
// with jest for the extra arguments to reach it.
export function runTests(root: string): JestReport {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-jest-'));
  const outFile = path.join(outDir, 'report.json');
  try {
    spawnSync('npm', ['test', '--', '--json', `--outputFile=${outFile}`], {
      cwd: root,
      encoding: 'utf8',
      shell: process.platform === 'win32',
    });
    if (!fs.existsSync(outFile)) {
      throw new Error('npm test did not write a Jest JSON report: the "test" script must run jest (e.g. "jest" or "tsc && jest")');
    }
    return JSON.parse(fs.readFileSync(outFile, 'utf8')) as JestReport;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

export function readEvidence(taskDir: string, stage: Stage): Evidence | null {
  const file = path.join(taskDir, `${stage}.json`);
  if (!fs.existsSync(file)) return null;

  let evidence: Partial<Evidence> | null;
  try {
    evidence = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    evidence = null;
  }
  if (
    !evidence ||
    typeof evidence.taskId !== 'string' ||
    !Array.isArray(evidence.tests) ||
    typeof evidence.testFiles !== 'object' ||
    evidence.testFiles === null
  ) {
    throw new Error(`Corrupt ${stage}.json in ${taskDir}`);
  }
  return evidence as Evidence;
}

export function writeEvidence(taskDir: string, stage: Stage, evidence: Evidence): void {
  fs.writeFileSync(path.join(taskDir, `${stage}.json`), `${JSON.stringify(evidence, null, 2)}\n`);
}
