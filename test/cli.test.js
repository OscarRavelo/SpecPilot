const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'specpilot.js');
const SPECS = path.join(__dirname, 'fixtures', 'specs');

const runIn = (cwd, ...args) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd });
const run = (...args) => runIn(process.cwd(), ...args);

describe('specpilot CLI', () => {
  test('--help lists the v0.1 commands', () => {
    const result = run('--help');

    expect(result.status).toBe(0);
    for (const command of ['init', 'spec lint', 'gate', 'reopen', 'tdd', 'mutate', 'verify', 'report', 'status']) {
      expect(result.stdout).toContain(command);
    }
  });

  test('no arguments prints help and exits 1', () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Usage: specpilot');
  });

  test('an unknown command exits 1', () => {
    const result = run('fly');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unknown command: fly');
  });

  test('a command that is not implemented yet says so and exits 1', () => {
    const result = run('verify');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"verify" is not implemented yet');
  });

  test('spec lint on a valid spec exits 0', () => {
    const result = run('spec', 'lint', path.join(SPECS, 'valid.md'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK: TASK-101 (2 acceptance criteria)');
  });

  test('spec lint uses the singular for one criterion', () => {
    const result = run('spec', 'lint', path.join(__dirname, '..', 'templates', 'spec.md'));
    expect(result.stdout).toBe('OK: TASK-000 (1 acceptance criterion)\n');
  });

  test('spec lint on an invalid spec lists errors as file:line and exits 1', () => {
    const file = path.join(SPECS, 'invalid.md');
    const result = run('spec', 'lint', file);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}:13 SPEC_DUPLICATE_AC AC-1 is duplicated`);
    expect(result.stderr).toContain('5 errors');
  });

  test('spec lint without a file exits 1', () => {
    const result = run('spec', 'lint');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: specpilot spec lint <file>');
  });

  test('spec lint on a missing file exits 1', () => {
    const result = run('spec', 'lint', path.join(SPECS, 'missing.md'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot read');
  });
});

describe('specpilot status / gate / reopen', () => {
  let project;
  const taskDir = () => path.join(project, 'specs', 'TASK-101');
  const phaseOf = () =>
    JSON.parse(fs.readFileSync(path.join(taskDir(), 'state.json'), 'utf8')).phase;
  const writeState = (phase) =>
    fs.writeFileSync(
      path.join(taskDir(), 'state.json'),
      JSON.stringify({ taskId: 'TASK-101', phase, history: [] }),
    );

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-cli-'));
    fs.mkdirSync(taskDir(), { recursive: true });
    fs.copyFileSync(path.join(SPECS, 'valid.md'), path.join(taskDir(), 'spec.md'));
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('status without a specs folder says so and exits 0', () => {
    fs.rmSync(path.join(project, 'specs'), { recursive: true });
    const result = runIn(project, 'status');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No tasks in specs/');
  });

  test('status lists each task with its phase', () => {
    fs.mkdirSync(path.join(project, 'specs', 'TASK-102'));
    fs.writeFileSync(
      path.join(project, 'specs', 'TASK-102', 'state.json'),
      JSON.stringify({ taskId: 'TASK-102', phase: 'red', history: [] }),
    );
    writeState('grill');

    const result = runIn(project, 'status');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('TASK-101  grill\nTASK-102  red\n');
  });

  test('gate moves to the next phase when the check passes', () => {
    const result = runIn(project, 'gate', 'TASK-101');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TASK-101: research → grill');
    expect(phaseOf()).toBe('grill');
  });

  test('gate stays put when the check fails and explains why', () => {
    writeState('grill');
    const result = runIn(project, 'gate', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TASK-101 is still in grill');
    expect(result.stderr).toContain('The grill gate is not implemented yet');
    expect(phaseOf()).toBe('grill');
  });

  test('gate on a missing task exits 1', () => {
    const result = runIn(project, 'gate', 'TASK-404');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No task TASK-404');
  });

  test('a corrupt state.json gives a clear error, without a stack trace', () => {
    fs.writeFileSync(path.join(taskDir(), 'state.json'), '{nope');
    for (const args of [['gate', 'TASK-101'], ['status']]) {
      const result = runIn(project, ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe(`Corrupt state.json in ${path.join('specs', 'TASK-101')}\n`);
    }
  });

  test('gate without a task prints usage', () => {
    const result = runIn(project, 'gate');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: specpilot gate <task>');
  });

  test('reopen goes back to an allowed earlier phase', () => {
    writeState('mutation');
    const result = runIn(project, 'reopen', 'TASK-101', 'red');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TASK-101: mutation → red');
    expect(phaseOf()).toBe('red');
  });

  test('reopen cannot be used to skip the gate', () => {
    const result = runIn(project, 'reopen', 'TASK-101', 'grill');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reopen only goes back');
    expect(fs.existsSync(path.join(taskDir(), 'state.json'))).toBe(false);
  });

  test('reopen rejects disallowed backward moves', () => {
    writeState('green');
    const result = runIn(project, 'reopen', 'TASK-101', 'research');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Cannot move from green to research');
    expect(phaseOf()).toBe('green');
  });

  test('reopen without arguments prints usage', () => {
    const result = runIn(project, 'reopen', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: specpilot reopen <task> <phase>');
  });
});
