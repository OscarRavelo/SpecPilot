import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runGate } from '../src/gates';
import { testFileHashes, writeEvidence } from '../src/tdd';
import type { Phase } from '../src/state';

const VALID_SPEC = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'specs', 'valid.md'),
  'utf8',
);

describe('runGate', () => {
  let dir: string;
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-gate-')), 'TASK-101');
    fs.mkdirSync(dir);
  });
  afterEach(() => fs.rmSync(path.dirname(dir), { recursive: true, force: true }));

  test('research passes with a valid spec whose id matches the folder', () => {
    fs.writeFileSync(path.join(dir, 'spec.md'), VALID_SPEC);
    expect(runGate(dir, 'research')).toEqual({ ok: true, reasons: [] });
  });

  test('research fails without spec.md', () => {
    expect(runGate(dir, 'research')).toEqual({
      ok: false,
      reasons: [`Missing ${path.join(dir, 'spec.md')}`],
    });
  });

  test('research fails with the lint errors', () => {
    fs.writeFileSync(path.join(dir, 'spec.md'), VALID_SPEC.replace('type: endpoint-fields', 'type: x'));
    expect(runGate(dir, 'research')).toEqual({
      ok: false,
      reasons: ['spec.md:3 SPEC_INVALID_TYPE Invalid type "x". Use: new-endpoint, endpoint-fields, react-component'],
    });
  });

  test('research fails when the spec id does not match the folder', () => {
    fs.writeFileSync(path.join(dir, 'spec.md'), VALID_SPEC.replace('TASK-101', 'TASK-999'));
    expect(runGate(dir, 'research')).toEqual({
      ok: false,
      reasons: ['Spec id (TASK-999) does not match its folder (TASK-101)'],
    });
  });

  test.each<Phase>(['plan'])(
    'the not-yet-implemented %s gate never lets the task through',
    (phase) => {
      fs.writeFileSync(path.join(dir, 'spec.md'), VALID_SPEC);
      expect(runGate(dir, phase)).toEqual({
        ok: false,
        reasons: [`The ${phase} gate is not implemented yet`],
      });
    },
  );

  // Only specpilot verify moves a task from verify to done; the gate points to it.
  test('the verify gate never lets the task through and says to run specpilot verify', () => {
    fs.writeFileSync(path.join(dir, 'spec.md'), VALID_SPEC);
    const result = runGate(dir, 'verify');
    expect(result.ok).toBe(false);
    expect(result.reasons.join('\n')).toContain('run specpilot verify TASK-101');
    expect(result.reasons.join('\n')).not.toContain('not implemented');
  });

  test('done has no gate', () => {
    expect(runGate(dir, 'done')).toEqual({ ok: false, reasons: ['The task is already done'] });
  });
});

describe('runGate: grill', () => {
  const FIXTURE = path.join(__dirname, 'fixtures', 'project');
  const COMPLETE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ledgers', 'complete.md'), 'utf8');
  let project: string;
  const taskDir = () => path.join(project, 'specs', 'TASK-102');
  const file = (name: string) => path.join(taskDir(), name);
  const read = (name: string) => fs.readFileSync(file(name), 'utf8');
  const write = (name: string, text: string) => fs.writeFileSync(file(name), text);
  // Computed here independently of src/audit.ts, so a wrong hash in the code is caught.
  const hashOf = (spec: string, ledger: string) =>
    crypto.createHash('sha256').update(`${spec}\0${ledger}`).digest('hex');
  const writeAudit = (blockers = '- none') =>
    write('audit.md', `# Grill audit: TASK-102\n\nLedger hash: ${hashOf(read('spec.md'), read('grill.md'))}\n\n## Blockers\n\n${blockers}\n`);
  const gate = () => runGate(taskDir(), 'grill', project);

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-grill-'));
    fs.cpSync(FIXTURE, project, { recursive: true });
    write('grill.md', COMPLETE);
    writeAudit();
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('passes with a complete ledger and a current audit without blockers', () => {
    expect(gate()).toEqual({ ok: true, reasons: [] });
  });

  test('fails if the spec no longer passes the research gate', () => {
    write('spec.md', read('spec.md').replace('type: endpoint-fields', 'type: x'));
    writeAudit();
    expect(gate().reasons).toEqual([
      'spec.md:3 SPEC_INVALID_TYPE Invalid type "x". Use: new-endpoint, endpoint-fields, react-component',
    ]);
  });

  test('fails without grill.md', () => {
    fs.rmSync(file('grill.md'));
    expect(gate()).toEqual({ ok: false, reasons: [`Missing ${file('grill.md')}`] });
  });

  test('reports ledger check errors', () => {
    write('grill.md', COMPLETE.replace('[human:Q5]', '[human:Q9]'));
    writeAudit();
    expect(gate().reasons).toEqual(['grill.md:34 CITE_UNKNOWN_QUESTION Q9 is not in the ledger']);
  });

  test('fails while a question is open', () => {
    write('grill.md', COMPLETE.replace('## Facts', '### Q6: Should the phone be unique?\n- Status: open\n\n## Facts'));
    writeAudit();
    expect(gate().reasons).toEqual(['Q6 is still open: Should the phone be unique?']);
  });

  test('a spec that says nothing about errors cannot leave the grill (planted ambiguity)', () => {
    write('grill.md', COMPLETE.replace('(validation, errors)', '(validation)'));
    writeAudit();
    expect(gate().reasons).toEqual([
      'Checklist item not covered: errors (error cases, status codes and error bodies)',
    ]);
  });

  test('every acceptance criterion must be cited by a fact', () => {
    write('spec.md', `${read('spec.md')}\n### AC-2: Rejects unknown users\n- Given no user with id 7\n- When I send PUT /users/7\n- Then the response status is 404\n`);
    writeAudit();
    expect(gate().reasons).toEqual(['AC-2 is not cited by any fact']);
  });

  test('fails without audit.md', () => {
    fs.rmSync(file('audit.md'));
    expect(gate().reasons).toEqual(['Missing audit.md: run the grill-auditor subagent']);
  });

  test('a ledger edited after the audit makes the audit stale', () => {
    write('grill.md', COMPLETE.replace('Auth stays as it is', 'Auth does not change'));
    expect(gate().reasons).toEqual([
      'audit.md is stale: spec.md or grill.md changed after the audit. Run the grill-auditor subagent again',
    ]);
  });

  test('a spec edited after the audit makes the audit stale', () => {
    write('spec.md', read('spec.md').replace('Sets a phone number', 'Sets the phone number'));
    expect(gate().reasons).toEqual([
      'audit.md is stale: spec.md or grill.md changed after the audit. Run the grill-auditor subagent again',
    ]);
  });

  test('each auditor blocker is a reason', () => {
    writeAudit('- Nothing says what happens if user 42 does not exist\n- Max phone length is unknown');
    expect(gate().reasons).toEqual([
      'Auditor blocker: Nothing says what happens if user 42 does not exist',
      'Auditor blocker: Max phone length is unknown',
    ]);
  });

  test('an audit without a "- none" Blockers section fails', () => {
    writeAudit('');
    expect(gate().reasons).toEqual(['audit.md must list its blockers under "## Blockers", or "- none"']);
  });

  test('reports every problem at once', () => {
    write('grill.md', COMPLETE.replace('(auth) ', '').replace('## Facts', '### Q6: Unique?\n- Status: open\n\n## Facts'));
    expect(gate().reasons).toEqual([
      'Q6 is still open: Unique?',
      'Checklist item not covered: auth (who may call it; permissions and roles)',
      'audit.md is stale: spec.md or grill.md changed after the audit. Run the grill-auditor subagent again',
    ]);
  });
});

describe('runGate: red and green', () => {
  let project: string;
  const taskDir = () => path.join(project, 'specs', 'TASK-101');
  const writeTest = (text: string) => fs.writeFileSync(path.join(project, 'test', 'a.test.js'), text);
  const record = (stage: 'red' | 'green') =>
    writeEvidence(taskDir(), stage, {
      taskId: 'TASK-101',
      at: '2026-10-18T10:00:00.000Z',
      tests: ['adds'],
      testFiles: testFileHashes(project),
    });

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-tdd-gate-'));
    fs.mkdirSync(taskDir(), { recursive: true });
    fs.mkdirSync(path.join(project, 'test'));
    writeTest('test 1');
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('red needs the evidence of tdd red', () => {
    expect(runGate(taskDir(), 'red', project)).toEqual({
      ok: false,
      reasons: ['Missing red.json: run specpilot tdd red TASK-101'],
    });
  });

  test('red passes when the tests are the ones tdd red saw fail', () => {
    record('red');
    expect(runGate(taskDir(), 'red', project)).toEqual({ ok: true, reasons: [] });
  });

  test('red fails when the tests changed after tdd red', () => {
    record('red');
    writeTest('test 2');
    expect(runGate(taskDir(), 'red', project)).toEqual({
      ok: false,
      reasons: ['Tests changed after tdd red (changed test/a.test.js): run specpilot tdd red TASK-101 again'],
    });
  });

  test('green needs the evidence of tdd green', () => {
    record('red');
    expect(runGate(taskDir(), 'green', project)).toEqual({
      ok: false,
      reasons: ['Missing green.json: run specpilot tdd green TASK-101'],
    });
  });

  test('green passes when red, green and the current tests all match', () => {
    record('red');
    record('green');
    expect(runGate(taskDir(), 'green', project)).toEqual({ ok: true, reasons: [] });
  });

  test('green fails when the tests changed after tdd green', () => {
    record('red');
    record('green');
    writeTest('test 2');
    expect(runGate(taskDir(), 'green', project)).toEqual({
      ok: false,
      reasons: ['Tests changed after tdd green (changed test/a.test.js): run specpilot tdd green TASK-101 again'],
    });
  });

  test('green fails when the tests differ between tdd red and tdd green', () => {
    record('red');
    writeTest('test 2');
    record('green');
    expect(runGate(taskDir(), 'green', project)).toEqual({
      ok: false,
      reasons: [
        'Tests changed between tdd red and tdd green (changed test/a.test.js): go back with specpilot reopen TASK-101 red',
      ],
    });
  });

  test('green without red.json fails', () => {
    record('green');
    expect(runGate(taskDir(), 'green', project)).toEqual({
      ok: false,
      reasons: ['Missing red.json: run specpilot tdd red TASK-101'],
    });
  });

  test('corrupt evidence is reported', () => {
    fs.writeFileSync(path.join(taskDir(), 'red.json'), '{nope');
    expect(runGate(taskDir(), 'red', project)).toEqual({
      ok: false,
      reasons: [`Corrupt red.json in ${taskDir()}`],
    });
  });
});

describe('runGate: mutation', () => {
  const RED_CODE = 'exports.sum = () => 0;\n';
  const GREEN_CODE = 'exports.sum = (a, b) => a + b;\n';
  const TEST_CODE = "test('AC-1 adds', () => {});\n";
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
    tests: ['AC-1 adds'],
    testFiles: hashesOf({ 'test/sum.test.js': TEST_CODE }),
    sourceFiles: hashesOf(sourceFiles),
  });
  const killed = { id: 'src/sum.js:1 ArithmeticOperator a * b', file: 'src/sum.js', line: 1, mutator: 'ArithmeticOperator', replacement: 'a * b', status: 'Killed' };
  const survivor = (status = 'Survived') => ({ id: SURVIVOR_ID, file: 'src/sum.js', line: 1, mutator: 'ArithmeticOperator', replacement: 'a - b', status });
  // A targeted bug recorded after tdd green, against the tests green.json saw.
  const bug = (ac: string, caught: boolean, overrides: Record<string, unknown> = {}) => ({
    ac,
    caught,
    at: '2026-10-18T10:05:00.000Z',
    sourceFiles: hashesOf({ 'src/sum.js': 'exports.sum = (a, b) => a - b;\n' }),
    testFiles: hashesOf({ 'test/sum.test.js': TEST_CODE }),
    failing: caught ? [`${ac} adds`] : [],
    ...overrides,
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
        bugs: [bug('AC-1', true), bug('AC-2', true)],
        ...overrides,
      }),
    );
  const writeEquivalents = (text: string) => fs.writeFileSync(path.join(taskDir(), 'equivalents.md'), text);
  const gate = () => runGate(taskDir(), 'mutation', project);

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-mutation-gate-'));
    fs.mkdirSync(taskDir(), { recursive: true });
    fs.mkdirSync(file('src'));
    fs.mkdirSync(file('test'));
    fs.writeFileSync(path.join(taskDir(), 'spec.md'), VALID_SPEC);
    fs.writeFileSync(file('src/sum.js'), GREEN_CODE);
    fs.writeFileSync(file('test/sum.test.js'), TEST_CODE);
    fs.writeFileSync(path.join(taskDir(), 'red.json'), JSON.stringify(evidence({ 'src/sum.js': RED_CODE })));
    fs.writeFileSync(path.join(taskDir(), 'green.json'), JSON.stringify(evidence({ 'src/sum.js': GREEN_CODE })));
    writeMutation();
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  const reasons = () => gate().reasons.join('\n');

  test('passes when every mutant is killed and every AC has a caught bug', () => {
    expect(gate()).toEqual({ ok: true, reasons: [] });
  });

  test('fails without mutation.json', () => {
    fs.rmSync(path.join(taskDir(), 'mutation.json'));
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain('mutation.json');
    expect(reasons()).toContain('specpilot mutate TASK-101');
  });

  test('a corrupt mutation.json is reported', () => {
    fs.writeFileSync(path.join(taskDir(), 'mutation.json'), '{nope');
    expect(gate().ok).toBe(false);
    expect(reasons()).toMatch(/Corrupt mutation\.json/);
  });

  test('fails when the Stryker run was over other source code', () => {
    writeMutation({ sourceFiles: hashesOf({ 'src/sum.js': 'exports.sum = (a, b) => b + a;\n' }) });
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain('src/sum.js');
    expect(reasons()).toContain('specpilot mutate TASK-101');
  });

  test('fails when the Stryker run was over other tests', () => {
    writeMutation({ testFiles: hashesOf({ 'test/sum.test.js': "test('AC-1 adds', () => { expect(1).toBe(1); });\n" }) });
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain('test/sum.test.js');
  });

  test('a bug left in the code after mutation fails the gate', () => {
    fs.writeFileSync(file('src/sum.js'), 'exports.sum = (a, b) => a - b;\n');
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain('src/sum.js');
  });

  test('a test changed after tdd green fails the gate', () => {
    fs.writeFileSync(file('test/sum.test.js'), "test('AC-1 adds', () => { expect(2).toBe(2); });\n");
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain('test/sum.test.js');
  });

  test('a surviving mutant fails the gate and names the mutant and the way back to red', () => {
    writeMutation({ mutants: [killed, survivor()] });
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain(SURVIVOR_ID);
    expect(reasons()).toContain('specpilot reopen TASK-101 red');
    expect(reasons()).not.toContain(killed.id);
  });

  test('a mutant without coverage fails the gate too', () => {
    writeMutation({ mutants: [survivor('NoCoverage')] });
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain(SURVIVOR_ID);
  });

  test('a survivor approved as equivalent with exactly its id passes', () => {
    writeMutation({ mutants: [killed, survivor()] });
    writeEquivalents(`# Equivalent mutants: TASK-101\n\n### ${SURVIVOR_ID}\n- Approved: yes\n- Reason: same result for these inputs\n`);
    expect(gate()).toEqual({ ok: true, reasons: [] });
  });

  test('a survivor listed but not approved fails the gate', () => {
    writeMutation({ mutants: [survivor()] });
    writeEquivalents(`### ${SURVIVOR_ID}\n- Approved: no\n- Reason: \n`);
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain(SURVIVOR_ID);
  });

  test('an approval for a near-identical id does not count', () => {
    writeMutation({ mutants: [survivor()] });
    writeEquivalents('### src/sum.js:2 ArithmeticOperator a - b\n- Approved: yes\n- Reason: other line\n');
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain(SURVIVOR_ID);
  });

  test('an AC without a targeted bug fails the gate and names the AC', () => {
    writeMutation({ bugs: [bug('AC-1', true)] });
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain('AC-2');
    expect(gate().reasons.some((reason) => /AC-1\b/.test(reason))).toBe(false);
  });

  test('an AC whose targeted bug was not caught fails the gate', () => {
    writeMutation({ bugs: [bug('AC-1', false), bug('AC-2', true)] });
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain('AC-1');
  });

  // A missed targeted bug is a test gap: a later caught one does not undo it.
  const expectMissedBugGap = (ac: string) => {
    expect(gate().ok).toBe(false);
    const reason = gate().reasons.find((text) => new RegExp(`\\b${ac}\\b`).test(text));
    expect(reason).toBeDefined();
    expect(reason).toMatch(/test gap/);
    expect(reason).toContain('specpilot reopen TASK-101 red');
  };

  test('an AC with a missed bug fails the gate even if a caught one was recorded later', () => {
    writeMutation({ bugs: [bug('AC-1', false), bug('AC-1', true), bug('AC-2', true)] });
    expectMissedBugGap('AC-1');
    expect(gate().reasons.some((text) => /\bAC-2\b/.test(text))).toBe(false);
  });

  test('a stale missed bug does not count, but a current missed one does', () => {
    const oldTests = hashesOf({ 'test/sum.test.js': "test('AC-1 adds', () => { expect(1).toBe(1); });\n" });
    writeMutation({
      bugs: [
        bug('AC-1', false, { at: '2026-10-18T09:59:00.000Z' }),
        bug('AC-1', false, { testFiles: oldTests }),
        bug('AC-1', true),
        bug('AC-2', true),
      ],
    });
    expect(gate()).toEqual({ ok: true, reasons: [] });

    writeMutation({
      bugs: [bug('AC-1', false, { at: '2026-10-18T09:59:00.000Z' }), bug('AC-1', false, { at: '2026-10-18T10:01:00.000Z' }), bug('AC-1', true), bug('AC-2', true)],
    });
    expectMissedBugGap('AC-1');
  });

  test('fails when mutation.json belongs to another task', () => {
    writeMutation({ taskId: 'TASK-999' });
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain('mutation.json');
    expect(reasons()).toContain('TASK-999');
  });

  test('fails without green.json', () => {
    fs.rmSync(path.join(taskDir(), 'green.json'));
    expect(gate()).toEqual({ ok: false, reasons: ['Missing green.json: run specpilot tdd green TASK-101'] });
  });

  test('fails when green.json has no source hashes and asks to rerun tdd red and tdd green', () => {
    const { sourceFiles, ...old } = evidence({ 'src/sum.js': GREEN_CODE });
    fs.writeFileSync(path.join(taskDir(), 'green.json'), JSON.stringify(old));
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain('green.json has no source file hashes');
    expect(reasons()).toContain('specpilot tdd green TASK-101');
  });

  test('a mutation.json written only by mutate bug means Stryker has not run yet', () => {
    writeMutation({ sourceFiles: {}, testFiles: {}, mutants: [] });
    expect(gate().ok).toBe(false);
    expect(gate().reasons).toContain('Stryker has not run yet: run specpilot mutate TASK-101');
  });

  test('a bug left in the code says to remove the injected bug', () => {
    fs.writeFileSync(file('src/sum.js'), 'exports.sum = (a, b) => a - b;\n');
    expect(gate().reasons).toEqual(['Source code differs from tdd green (changed src/sum.js): remove the injected bug']);
  });

  test.each(['Pending', 'RuntimeError', 'Ignored'])('a %s mutant fails the gate like a survivor', (status) => {
    writeMutation({ mutants: [killed, survivor(status)] });
    expect(gate().ok).toBe(false);
    expect(reasons()).toContain(`Surviving mutant ${SURVIVOR_ID} (${status})`);
    expect(reasons()).toContain('specpilot reopen TASK-101 red');
  });

  test.each(['Pending', 'RuntimeError', 'Ignored'])('a %s mutant passes only with a human approval', (status) => {
    writeMutation({ mutants: [killed, survivor(status)] });
    writeEquivalents(`### ${SURVIVOR_ID}\n- Approved: yes\n- Reason: checked by the human\n`);
    expect(gate()).toEqual({ ok: true, reasons: [] });
  });

  // A targeted bug counts only for the current green: the tests it ran against are green.json's,
  // and it was recorded after tdd green.
  describe('a caught bug from an earlier round does not count', () => {
    const noCaughtBug = (ac: string) => {
      expect(gate().ok).toBe(false);
      const reason = gate().reasons.find((text) => new RegExp(`\\b${ac}\\b`).test(text));
      expect(reason).toBeDefined();
      expect(reason).toContain(`specpilot mutate bug TASK-101 ${ac}`);
    };

    test('a bug recorded against other tests', () => {
      const oldTests = hashesOf({ 'test/sum.test.js': "test('AC-1 adds', () => { expect(1).toBe(1); });\n" });
      writeMutation({ bugs: [bug('AC-1', true, { testFiles: oldTests }), bug('AC-2', true)] });
      noCaughtBug('AC-1');
    });

    test('a bug recorded before tdd green', () => {
      writeMutation({ bugs: [bug('AC-1', true, { at: '2026-10-18T09:59:00.000Z' }), bug('AC-2', true)] });
      noCaughtBug('AC-1');
    });

    test('a bug recorded at the same moment as tdd green', () => {
      writeMutation({ bugs: [bug('AC-1', true), bug('AC-2', true, { at: '2026-10-18T10:00:00.000Z' })] });
      noCaughtBug('AC-2');
    });

    test('a bug without test hashes (recorded before they were stored)', () => {
      const { testFiles, ...old } = bug('AC-1', true);
      writeMutation({ bugs: [old, bug('AC-2', true)] });
      noCaughtBug('AC-1');
    });

    test('next to stale bugs, only an AC with a current caught bug passes', () => {
      writeMutation({
        bugs: [bug('AC-1', true, { at: '2026-10-18T09:00:00.000Z' }), bug('AC-2', true, { at: '2026-10-18T09:00:00.000Z' }), bug('AC-2', true)],
      });
      noCaughtBug('AC-1');
      expect(gate().reasons.some((text) => /\bAC-2\b/.test(text))).toBe(false);
    });
  });
});
