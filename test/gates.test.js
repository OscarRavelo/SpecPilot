const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGate } = require('../src/gates');

const VALID_SPEC = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'specs', 'valid.md'),
  'utf8',
);

describe('runGate', () => {
  let dir;
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

  test.each(['grill', 'plan', 'red', 'green', 'mutation', 'verify'])(
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
