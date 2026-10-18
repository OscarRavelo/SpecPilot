import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  failingTests,
  greenProblems,
  hashChanges,
  passingTests,
  readEvidence,
  redProblems,
  testFileHashes,
  writeEvidence,
} from '../src/tdd';
import type { JestAssertion, JestReport, JestSuite } from '../src/tdd';

// Shapes taken from a real Jest 30 --json report.
const ROOT = '/project';
const assertionFailure = (fullName: string): JestAssertion => ({
  fullName,
  status: 'failed',
  failureMessages: ['Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: 3\nReceived: 0'],
  failureDetails: [{ matcherResult: { name: 'toBe', pass: false } }],
});
const errorFailure = (fullName: string): JestAssertion => ({
  fullName,
  status: 'failed',
  failureMessages: ["TypeError: sum.nope is not a function\n    at Object.<anonymous> (/project/test/sum.test.js:3:30)"],
  failureDetails: [{}],
});
const passed = (fullName: string): JestAssertion => ({
  fullName,
  status: 'passed',
  failureMessages: [],
  failureDetails: [],
});
const suite = (file: string, assertions: JestAssertion[]): JestSuite => ({
  name: path.join(ROOT, file),
  status: assertions.some((a) => a.status === 'failed') ? 'failed' : 'passed',
  message: '',
  assertionResults: assertions,
});
const brokenSuite = (file: string): JestSuite => ({
  name: path.join(ROOT, file),
  status: 'failed',
  message: "  ● Test suite failed to run\n\n    Cannot find module '../src/missing' from 'test/broken.test.js'\n\n      at Resolver",
  assertionResults: [],
});
const report = (...suites: JestSuite[]): JestReport => {
  const all = suites.flatMap((s) => s.assertionResults);
  return {
    numTotalTests: all.length,
    numFailedTests: all.filter((a) => a.status === 'failed').length,
    testResults: suites,
  };
};

describe('redProblems', () => {
  test('tests that fail on assertions are a valid red', () => {
    const r = report(suite('test/sum.test.js', [assertionFailure('adds'), passed('keeps zero')]));
    expect(redProblems(r, ROOT)).toEqual([]);
  });

  test('red needs at least one failing test', () => {
    expect(redProblems(report(suite('test/sum.test.js', [passed('adds')])), ROOT)).toEqual([
      'No test fails: red needs at least one test that fails on an assertion',
    ]);
    expect(redProblems(report(), ROOT)).toEqual([
      'No test fails: red needs at least one test that fails on an assertion',
    ]);
  });

  test('a test that throws instead of failing an assertion is not red', () => {
    const r = report(suite('test/sum.test.js', [assertionFailure('adds'), errorFailure('throws')]));
    expect(redProblems(r, ROOT)).toEqual([
      '"throws" fails with an error, not an assertion: TypeError: sum.nope is not a function',
    ]);
  });

  test('a failure with no details, or with an error next to an assertion, is not an assertion failure', () => {
    const noDetails: JestAssertion = { ...errorFailure('no details'), failureDetails: [] };
    const mixed: JestAssertion = { ...errorFailure('mixed'), failureDetails: [{ matcherResult: { pass: false } }, {}] };
    expect(redProblems(report(suite('test/sum.test.js', [noDetails, mixed])), ROOT)).toEqual([
      '"no details" fails with an error, not an assertion: TypeError: sum.nope is not a function',
      '"mixed" fails with an error, not an assertion: TypeError: sum.nope is not a function',
    ]);
  });

  test('a suite that fails to run (compile error, missing module) is not red', () => {
    const r = report(suite('test/sum.test.js', [assertionFailure('adds')]), brokenSuite('test/broken.test.js'));
    expect(redProblems(r, ROOT)).toEqual([
      "test/broken.test.js failed to run: Cannot find module '../src/missing' from 'test/broken.test.js'",
    ]);
  });

  test('a broken suite alone reports only the suite', () => {
    expect(redProblems(report(brokenSuite('test/broken.test.js')), ROOT)).toEqual([
      "test/broken.test.js failed to run: Cannot find module '../src/missing' from 'test/broken.test.js'",
    ]);
  });
});

describe('greenProblems', () => {
  test('all tests passing is green', () => {
    expect(greenProblems(report(suite('test/sum.test.js', [passed('adds'), passed('keeps zero')])), ROOT)).toEqual([]);
  });

  test('every failing test is listed, whatever the cause', () => {
    const r = report(suite('test/sum.test.js', [assertionFailure('adds'), errorFailure('throws'), passed('ok')]));
    expect(greenProblems(r, ROOT)).toEqual(['"adds" still fails', '"throws" still fails']);
  });

  test('a suite that fails to run is not green', () => {
    expect(greenProblems(report(suite('test/a.test.js', [passed('a')]), brokenSuite('test/broken.test.js')), ROOT)).toEqual([
      "test/broken.test.js failed to run: Cannot find module '../src/missing' from 'test/broken.test.js'",
    ]);
  });

  test('no tests at all is not green', () => {
    expect(greenProblems(report(), ROOT)).toEqual(['No tests ran']);
  });
});

test('failingTests and passingTests list full test names', () => {
  const r = report(
    suite('test/a.test.js', [assertionFailure('a fails'), passed('a passes'), { ...passed('a skipped'), status: 'pending' }]),
    suite('test/b.test.js', [passed('b passes')]),
  );
  expect(failingTests(r)).toEqual(['a fails']);
  expect(passingTests(r)).toEqual(['a passes', 'b passes']);
});

describe('testFileHashes', () => {
  let root: string;
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-tdd-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('hashes every test file, keyed by its path, and ignores everything else', () => {
    write('test/a.test.js', 'a');
    write('test/a/z.test.js', 'z');
    write('src/b.spec.ts', 'b');
    write('src/__tests__/c.ts', 'c');
    write('test/fixtures/user.json', '{}');
    write('src/b.ts', 'code');
    write('README.md', 'docs');
    write('node_modules/lib/x.test.js', 'x');
    write('dist/a.test.js', 'built');
    write('coverage/a.test.js', 'report');
    write('.git/hooks/a.test.js', 'git');

    const hashes = testFileHashes(root);
    expect(Object.keys(hashes)).toEqual([
      'src/__tests__/c.ts',
      'src/b.spec.ts',
      'test/a.test.js',
      'test/a/z.test.js',
      'test/fixtures/user.json',
    ]);
    expect(hashes['test/a.test.js']).toBe('ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb');
  });

  test('changing a test changes its hash', () => {
    write('test/a.test.js', 'a');
    const before = testFileHashes(root);
    write('test/a.test.js', 'a2');
    expect(testFileHashes(root)['test/a.test.js']).not.toBe(before['test/a.test.js']);
  });
});

test('hashChanges lists changed, added and removed test files', () => {
  expect(hashChanges({ a: '1', b: '2', c: '3' }, { a: '1', b: 'x', d: '4' })).toEqual([
    'changed b',
    'added d',
    'removed c',
  ]);
  expect(hashChanges({ a: '1' }, { a: '1' })).toEqual([]);
});

describe('evidence files', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-evidence-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('round-trip through red.json and green.json', () => {
    const evidence = { taskId: 'TASK-101', at: '2026-10-18T10:00:00.000Z', tests: ['adds'], testFiles: { 'test/a.test.js': 'h' } };
    writeEvidence(dir, 'red', evidence);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'red.json'), 'utf8'))).toEqual(evidence);
    expect(readEvidence(dir, 'red')).toEqual(evidence);
    expect(readEvidence(dir, 'green')).toBeNull();
  });

  test('a corrupt evidence file is an error, not missing evidence', () => {
    fs.writeFileSync(path.join(dir, 'green.json'), '{nope');
    expect(() => readEvidence(dir, 'green')).toThrow(`Corrupt green.json in ${dir}`);
    fs.writeFileSync(path.join(dir, 'green.json'), '{"taskId":"T"}');
    expect(() => readEvidence(dir, 'green')).toThrow(`Corrupt green.json in ${dir}`);
    fs.writeFileSync(path.join(dir, 'green.json'), '{"tests":[],"testFiles":{}}');
    expect(() => readEvidence(dir, 'green')).toThrow(`Corrupt green.json in ${dir}`);
  });
});
