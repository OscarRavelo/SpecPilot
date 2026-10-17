import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runGate } from '../src/gates';
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

  test.each<Phase>(['plan', 'red', 'green', 'mutation', 'verify'])(
    'the not-yet-implemented %s gate never lets the task through',
    (phase) => {
      fs.writeFileSync(path.join(dir, 'spec.md'), VALID_SPEC);
      expect(runGate(dir, phase)).toEqual({
        ok: false,
        reasons: [`The ${phase} gate is not implemented yet`],
      });
    },
  );

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
