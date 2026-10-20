import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { acCoverage, readHallucinations, recordHallucination, verifyProblems } from '../src/verify';
import type { Hallucination } from '../src/verify';
import type { JestAssertion, JestReport } from '../src/tdd';

const VALID_SPEC = fs.readFileSync(path.join(__dirname, 'fixtures', 'specs', 'valid.md'), 'utf8');

// A hand-built Jest report: one suite holding the given tests.
const passed = (fullName: string): JestAssertion => ({ fullName, status: 'passed', failureMessages: [], failureDetails: [] });
const failed = (fullName: string): JestAssertion => ({
  fullName,
  status: 'failed',
  failureMessages: ['Error: expect(received).toBe(expected)'],
  failureDetails: [{ matcherResult: { pass: false } }],
});
const reportOf = (suiteFile: string, ...tests: JestAssertion[]): JestReport => ({
  numTotalTests: tests.length,
  numFailedTests: tests.filter((test) => test.status === 'failed').length,
  testResults:
    tests.length === 0
      ? []
      : [
          {
            name: suiteFile,
            status: tests.some((test) => test.status === 'failed') ? 'failed' : 'passed',
            message: '',
            assertionResults: tests,
          },
        ],
});

describe('acCoverage', () => {
  const report = (...tests: JestAssertion[]) => reportOf('/project/test/a.test.js', ...tests);

  test('maps each AC to the passing tests that name it, and an AC without tests to []', () => {
    const coverage = acCoverage(report(passed('AC-1: stores the phone'), passed('AC-2 rejects abc')), ['AC-1', 'AC-2', 'AC-3']);
    expect(coverage).toEqual({ 'AC-1': ['AC-1: stores the phone'], 'AC-2': ['AC-2 rejects abc'], 'AC-3': [] });
  });

  test('a failing test that names an AC does not cover it', () => {
    const coverage = acCoverage(report(passed('AC-1 stores'), failed('AC-2 rejects'), failed('AC-1 stores twice')), ['AC-1', 'AC-2']);
    expect(coverage).toEqual({ 'AC-1': ['AC-1 stores'], 'AC-2': [] });
  });

  test('an AC is named only as a whole id', () => {
    const coverage = acCoverage(
      report(
        passed('AC-1: x'),
        passed('stores the phone AC-1.'),
        passed('AC-12 something else'),
        passed('AC-1.2 a sub-criterion'),
        passed('AC-1x not an id'),
        passed('XAC-1 not an id'),
      ),
      ['AC-1'],
    );
    expect(coverage).toEqual({ 'AC-1': ['AC-1: x', 'stores the phone AC-1.'] });
  });

  test('every passing test that names the AC is listed, in report order, also inside describe blocks', () => {
    const coverage = acCoverage(
      report(passed('users AC-2 rejects abc'), passed('AC-1 stores'), passed('users AC-2 rejects 12'), passed('unrelated')),
      ['AC-1', 'AC-2'],
    );
    expect(coverage).toEqual({ 'AC-1': ['AC-1 stores'], 'AC-2': ['users AC-2 rejects abc', 'users AC-2 rejects 12'] });
  });
});

describe('recordHallucination / readHallucinations', () => {
  let dir: string;
  const entry = (reasons: string[], at = '2026-10-20T10:00:00.000Z'): Hallucination => ({ taskId: 'TASK-101', at, phase: 'verify', reasons });
  const file = () => path.join(dir, 'hallucinations.json');

  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-hallucinations-')), 'TASK-101');
    fs.mkdirSync(dir);
  });
  afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  test('a missing file reads as [], and a recorded entry creates the file as a JSON array', () => {
    expect(readHallucinations(dir)).toEqual([]);
    const first = entry(['AC-2 has no test that covers it']);
    recordHallucination(dir, first);
    expect(fs.existsSync(file())).toBe(true);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual([first]);
    expect(readHallucinations(dir)).toEqual([first]);
  });

  test('each entry is appended, never replacing the earlier ones', () => {
    const first = entry(['AC-2 has no test that covers it']);
    const second = entry(['"AC-1 stores" still fails', 'AC-1 has no test that covers it'], '2026-10-20T11:00:00.000Z');
    recordHallucination(dir, first);
    recordHallucination(dir, second);
    expect(readHallucinations(dir)).toEqual([first, second]);
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual([first, second]);
  });
});

// A task in verify whose mutation evidence passes the mutation gate (as in test/gates.test.ts), so the
// only problems are the ones the hand-built report brings.
describe('verifyProblems', () => {
  const RED_CODE = 'exports.sum = () => 0;\n';
  const GREEN_CODE = 'exports.sum = (a, b) => a + b;\n';
  const TEST_CODE = "test('AC-1 adds', () => {});\ntest('AC-2 rejects', () => {});\n";
  const SURVIVOR_ID = 'src/sum.js:1 ArithmeticOperator a - b';
  let project: string;
  const taskDir = () => path.join(project, 'specs', 'TASK-101');
  const file = (name: string) => path.join(project, name);
  const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
  const hashesOf = (files: Record<string, string>) =>
    Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)]));
  const evidence = (sourceFiles: Record<string, string>) => ({
    taskId: 'TASK-101',
    at: '2026-10-18T10:00:00.000Z',
    tests: ['AC-1 adds', 'AC-2 rejects'],
    testFiles: hashesOf({ 'test/sum.test.js': TEST_CODE }),
    sourceFiles: hashesOf(sourceFiles),
  });
  const killed = { id: 'src/sum.js:1 ArithmeticOperator a * b', file: 'src/sum.js', line: 1, mutator: 'ArithmeticOperator', replacement: 'a * b', status: 'Killed' };
  const bug = (ac: string) => ({
    ac,
    caught: true,
    at: '2026-10-18T10:05:00.000Z',
    sourceFiles: hashesOf({ 'src/sum.js': 'exports.sum = (a, b) => a - b;\n' }),
    testFiles: hashesOf({ 'test/sum.test.js': TEST_CODE }),
    failing: [`${ac} adds`],
  });
  const writeMutation = (overrides: Record<string, unknown> = {}) =>
    fs.writeFileSync(
      path.join(taskDir(), 'mutation.json'),
      JSON.stringify({
        taskId: 'TASK-101',
        at: '2026-10-18T10:10:00.000Z',
        sourceFiles: hashesOf({ 'src/sum.js': GREEN_CODE }),
        testFiles: hashesOf({ 'test/sum.test.js': TEST_CODE }),
        mutants: [killed],
        bugs: [bug('AC-1'), bug('AC-2')],
        ...overrides,
      }),
    );
  const report = (...tests: JestAssertion[]) => reportOf(file('test/sum.test.js'), ...tests);
  const problems = (...tests: JestAssertion[]) => verifyProblems(taskDir(), project, report(...tests));

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-verify-'));
    fs.mkdirSync(taskDir(), { recursive: true });
    fs.mkdirSync(file('src'));
    fs.mkdirSync(file('test'));
    fs.writeFileSync(path.join(taskDir(), 'spec.md'), VALID_SPEC);
    fs.writeFileSync(path.join(taskDir(), 'state.json'), JSON.stringify({ taskId: 'TASK-101', phase: 'verify', history: [] }));
    fs.writeFileSync(file('src/sum.js'), GREEN_CODE);
    fs.writeFileSync(file('test/sum.test.js'), TEST_CODE);
    fs.writeFileSync(path.join(taskDir(), 'red.json'), JSON.stringify(evidence({ 'src/sum.js': RED_CODE })));
    fs.writeFileSync(path.join(taskDir(), 'green.json'), JSON.stringify(evidence({ 'src/sum.js': GREEN_CODE })));
    writeMutation();
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('no problems when every AC has a passing test, and an uncovered AC is named exactly', () => {
    expect(problems(passed('AC-1 adds'), passed('AC-2 rejects'))).toEqual([]);
    expect(problems(passed('AC-1 adds'), passed('adds again'))).toEqual(['AC-2 has no test that covers it']);
  });

  test('every uncovered AC is a reason, in spec order', () => {
    expect(problems(passed('adds'))).toEqual(['AC-1 has no test that covers it', 'AC-2 has no test that covers it']);
  });

  test('an AC named only as part of another id is not covered', () => {
    expect(problems(passed('AC-1 adds'), passed('AC-21 rejects'), passed('AC-2.1 rejects'), passed('XAC-2 rejects'))).toEqual([
      'AC-2 has no test that covers it',
    ]);
  });

  test('a failing test is a reason, and the AC it names is not covered by it', () => {
    expect(problems(passed('AC-1 adds'), failed('AC-2 rejects'))).toEqual(['"AC-2 rejects" still fails', 'AC-2 has no test that covers it']);
  });

  test('a failing test fails verify even when its AC is covered by another test', () => {
    expect(problems(passed('AC-1 adds'), passed('AC-2 rejects'), failed('AC-2 rejects twice'))).toEqual(['"AC-2 rejects twice" still fails']);
  });

  test('a run without tests says so', () => {
    expect(problems()).toEqual(['No tests ran', 'AC-1 has no test that covers it', 'AC-2 has no test that covers it']);
  });

  test('a suite that fails to run is a reason', () => {
    const broken: JestReport = {
      numTotalTests: 2,
      numFailedTests: 0,
      testResults: [
        { name: file('test/broken.test.js'), status: 'failed', message: "  ● Test suite failed to run\n\n    Cannot find module '../src/missing'\n", assertionResults: [] },
        { name: file('test/sum.test.js'), status: 'passed', message: '', assertionResults: [passed('AC-1 adds'), passed('AC-2 rejects')] },
      ],
    };
    expect(verifyProblems(taskDir(), project, broken)).toEqual(["test/broken.test.js failed to run: Cannot find module '../src/missing'"]);
  });

  test('the mutation gate is rerun: code that differs from tdd green is a reason', () => {
    fs.writeFileSync(file('src/sum.js'), 'exports.sum = (a, b) => a - b;\n');
    expect(problems(passed('AC-1 adds'), passed('AC-2 rejects'))).toEqual([
      'Source code differs from tdd green (changed src/sum.js): remove the injected bug',
    ]);
  });

  test('the mutation gate is rerun: tests changed after tdd green are a reason', () => {
    fs.writeFileSync(file('test/sum.test.js'), `${TEST_CODE}// changed\n`);
    const reasons = problems(passed('AC-1 adds'), passed('AC-2 rejects'));
    expect(reasons).toEqual([
      'Tests changed after tdd green (changed test/sum.test.js): go back with specpilot reopen TASK-101 red',
    ]);
  });

  test('the mutation gate is rerun: an unapproved survivor is a reason', () => {
    writeMutation({ mutants: [killed, { ...killed, id: SURVIVOR_ID, replacement: 'a - b', status: 'Survived' }] });
    const reasons = problems(passed('AC-1 adds'), passed('AC-2 rejects'));
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain(`Surviving mutant ${SURVIVOR_ID} (Survived)`);
  });

  test('the mutation gate is rerun: an AC without a caught bug since green is a reason', () => {
    writeMutation({ bugs: [bug('AC-1')] });
    expect(problems(passed('AC-1 adds'), passed('AC-2 rejects'))).toEqual([
      'AC-2 has no targeted bug since tdd green: inject one and run specpilot mutate bug TASK-101 AC-2',
    ]);
  });

  test('the mutation gate is rerun: Stryker evidence over other code is a reason', () => {
    writeMutation({ sourceFiles: hashesOf({ 'src/sum.js': 'exports.sum = (a, b) => b + a;\n' }) });
    expect(problems(passed('AC-1 adds'), passed('AC-2 rejects'))).toEqual([
      'Stryker ran over other code (changed src/sum.js): run specpilot mutate TASK-101 again',
    ]);
  });

  test('problems from the mutation gate, the test run and coverage are all reported, in that order', () => {
    writeMutation({ bugs: [bug('AC-1')] });
    expect(problems(passed('AC-1 adds'), failed('AC-2 rejects'))).toEqual([
      'AC-2 has no targeted bug since tdd green: inject one and run specpilot mutate bug TASK-101 AC-2',
      '"AC-2 rejects" still fails',
      'AC-2 has no test that covers it',
    ]);
  });
});
