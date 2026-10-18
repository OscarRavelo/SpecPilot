import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

// Runs the compiled CLI, i.e. exactly what gets published (`npm test` builds first).
const BIN = path.join(__dirname, '..', 'dist', 'cli.js');
const SPECS = path.join(__dirname, 'fixtures', 'specs');

const runIn = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd });
const run = (...args: string[]) => runIn(process.cwd(), ...args);

describe('specpilot CLI', () => {
  test('--help lists the v0.1 commands', () => {
    const result = run('--help');

    expect(result.status).toBe(0);
    for (const command of ['init', 'spec lint', 'ledger check', 'grill checklist', 'grill hash', 'hook pre-tool-use', 'hook stop', 'gate', 'reopen', 'tdd', 'mutate', 'verify', 'report', 'status']) {
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
  let project: string;
  const taskDir = () => path.join(project, 'specs', 'TASK-101');
  const phaseOf = () =>
    JSON.parse(fs.readFileSync(path.join(taskDir(), 'state.json'), 'utf8')).phase;
  const writeState = (phase: string) =>
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
    expect(result.stderr).toContain(`Missing ${path.join('specs', 'TASK-101', 'grill.md')}`);
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

describe('specpilot ledger check', () => {
  const FIXTURE = path.join(__dirname, 'fixtures', 'project');
  let project: string;
  const ledgerFile = () => path.join(project, 'specs', 'TASK-102', 'grill.md');

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-ledger-'));
    fs.cpSync(FIXTURE, project, { recursive: true });
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('a ledger whose citations hold exits 0 and says what it checked', () => {
    const result = runIn(project, 'ledger', 'check', 'TASK-102');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('OK: TASK-102 ledger (5 facts, 6 citations checked)\n');
  });

  test('a broken citation is reported as file:line and exits 1', () => {
    const text = fs.readFileSync(ledgerFile(), 'utf8');
    fs.writeFileSync(ledgerFile(), text.replace('"export function updateUser("', '"export function updateUsers("'));

    const result = runIn(project, 'ledger', 'check', 'TASK-102');
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(
      `${path.join('specs', 'TASK-102', 'grill.md')}:16 CITE_SNIPPET_MISMATCH "export function updateUsers(" is not in src/routes/users.ts:9\n1 error\n`,
    );
  });

  test('a task without grill.md exits 1', () => {
    fs.rmSync(ledgerFile());
    const result = runIn(project, 'ledger', 'check', 'TASK-102');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Missing ${path.join('specs', 'TASK-102', 'grill.md')}`);
  });

  test('a missing task exits 1', () => {
    const result = runIn(project, 'ledger', 'check', 'TASK-404');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No task TASK-404');
  });

  test('ledger check without a task prints usage', () => {
    const result = runIn(project, 'ledger', 'check');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: specpilot ledger check <task>');
  });
});

describe('specpilot grill', () => {
  const FIXTURE = path.join(__dirname, 'fixtures', 'project');
  const COMPLETE = fs.readFileSync(path.join(__dirname, 'fixtures', 'ledgers', 'complete.md'), 'utf8');
  let project: string;
  const file = (name: string) => path.join(project, 'specs', 'TASK-102', name);
  const hash = () =>
    crypto
      .createHash('sha256')
      .update(`${fs.readFileSync(file('spec.md'), 'utf8')}\0${fs.readFileSync(file('grill.md'), 'utf8')}`)
      .digest('hex');

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-grill-cli-'));
    fs.cpSync(FIXTURE, project, { recursive: true });
    fs.writeFileSync(file('grill.md'), COMPLETE.replace('(auth) ', ''));
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('grill checklist marks covered and missing items for the task type', () => {
    const result = runIn(project, 'grill', 'checklist', 'TASK-102');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      [
        'TASK-102 (endpoint-fields): 7/8 covered',
        '[x] contract: route, method, request body and response body',
        '[x] validation: which inputs are accepted or rejected, and the exact rules',
        '[x] errors: error cases, status codes and error bodies',
        '[x] data: models, persistence and migrations affected',
        '[ ] auth: who may call it; permissions and roles',
        '[x] compatibility: existing clients and callers keep working',
        '[x] edge-cases: empty, null, duplicate, missing and boundary values',
        '[x] out-of-scope: what this task must not touch',
        '',
      ].join('\n'),
    );
  });

  test('grill checklist works before grill.md exists', () => {
    fs.rmSync(file('grill.md'));
    const result = runIn(project, 'grill', 'checklist', 'TASK-102');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('TASK-102 (endpoint-fields): 0/8 covered');
  });

  test('grill hash prints the hash the auditor must record', () => {
    const result = runIn(project, 'grill', 'hash', 'TASK-102');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${hash()}\n`);
  });

  test('gate moves a task from grill to plan when the grill is complete and audited', () => {
    fs.writeFileSync(file('grill.md'), COMPLETE);
    fs.writeFileSync(file('state.json'), JSON.stringify({ taskId: 'TASK-102', phase: 'grill', history: [] }));
    fs.writeFileSync(file('audit.md'), `Ledger hash: ${hash()}\n\n## Blockers\n\n- none\n`);

    const result = runIn(project, 'gate', 'TASK-102');
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('TASK-102: grill → plan');
  });

  test.each([
    [['grill', 'checklist'], 'Usage: specpilot grill checklist <task>'],
    [['grill', 'hash'], 'Usage: specpilot grill hash <task>'],
  ])('%j without a task prints usage', (args, usage) => {
    const result = runIn(project, ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(usage);
  });

  test('grill on a missing task exits 1', () => {
    const result = runIn(project, 'grill', 'hash', 'TASK-404');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No task TASK-404');
  });
});

describe('specpilot hook pre-tool-use', () => {
  let project: string;

  // Claude Code passes the tool call as JSON on stdin; exit 2 blocks it and stderr is shown to the agent.
  const hook = (input: string, env: Record<string, string> = {}) => {
    const { SPECPILOT_TASK, CLAUDE_PROJECT_DIR, ...rest } = process.env;
    return spawnSync(process.execPath, [BIN, 'hook', 'pre-tool-use'], {
      encoding: 'utf8',
      cwd: project,
      input,
      env: { ...rest, ...env },
    });
  };
  const write = (file: string) =>
    JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: path.join(project, file) } });
  const writeTask = (taskId: string, phase: string) => {
    fs.mkdirSync(path.join(project, 'specs', taskId), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'specs', taskId, 'state.json'),
      JSON.stringify({ taskId, phase, history: [] }),
    );
  };

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-hook-'));
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('an allowed edit exits 0 with no output', () => {
    writeTask('TASK-101', 'green');
    const result = hook(write('src/users.ts'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
  });

  test('a blocked edit exits 2 and explains why on stderr', () => {
    writeTask('TASK-101', 'plan');
    const result = hook(write('src/users.ts'));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('TASK-101 is in plan');
  });

  test('a Bash command that writes code is blocked too', () => {
    writeTask('TASK-101', 'plan');
    const input = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo x > src/users.ts' } });
    const result = hook(input);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('src/users.ts cannot be edited');
  });

  test('SPECPILOT_TASK chooses the task', () => {
    writeTask('TASK-101', 'red');
    writeTask('TASK-102', 'green');
    expect(hook(write('src/users.ts')).status).toBe(2);
    expect(hook(write('src/users.ts'), { SPECPILOT_TASK: 'TASK-102' }).status).toBe(0);
  });

  test('CLAUDE_PROJECT_DIR sets the project root', () => {
    writeTask('TASK-101', 'plan');
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-hook-cwd-'));
    try {
      const result = spawnSync(process.execPath, [BIN, 'hook', 'pre-tool-use'], {
        encoding: 'utf8',
        cwd: elsewhere,
        input: write('src/users.ts'),
        env: { ...process.env, CLAUDE_PROJECT_DIR: project, SPECPILOT_TASK: '' },
      });
      expect(result.status).toBe(2);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  test('input that is not a tool call blocks instead of letting it through', () => {
    for (const input of ['{nope', '', '{}']) {
      const result = hook(input);
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('Invalid hook input');
    }
  });

  test('an unknown hook event exits 1 with usage', () => {
    const result = spawnSync(process.execPath, [BIN, 'hook', 'post-tool-use'], { encoding: 'utf8', cwd: project, input: '{}' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: specpilot hook pre-tool-use');
  });
});

describe('specpilot hook stop', () => {
  let project: string;

  // A Stop hook that exits 2 forces the agent to keep going; this one only warns, so it always exits 0.
  const stop = (input = '{"hook_event_name":"Stop"}', env: Record<string, string> = {}) => {
    const { SPECPILOT_TASK, CLAUDE_PROJECT_DIR, ...rest } = process.env;
    return spawnSync(process.execPath, [BIN, 'hook', 'stop'], {
      encoding: 'utf8',
      cwd: project,
      input,
      env: { ...rest, ...env },
    });
  };
  const writeTask = (taskId: string, phase: string) => {
    fs.mkdirSync(path.join(project, 'specs', taskId), { recursive: true });
    fs.writeFileSync(
      path.join(project, 'specs', taskId, 'state.json'),
      JSON.stringify({ taskId, phase, history: [] }),
    );
  };

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-stop-cli-'));
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('a task waiting for mutation is shown as a system message, without blocking', () => {
    writeTask('TASK-101', 'mutation');
    const result = stop();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ systemMessage: expect.stringContaining('TASK-101 is in mutation') });
  });

  test('nothing to report prints nothing', () => {
    writeTask('TASK-101', 'green');
    const result = stop();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  test('SPECPILOT_TASK chooses the task', () => {
    writeTask('TASK-101', 'mutation');
    writeTask('TASK-102', 'green');
    expect(stop(undefined, { SPECPILOT_TASK: 'TASK-102' }).stdout).toBe('');
    expect(stop().stdout).toContain('TASK-101 is in mutation');
  });

  test('a corrupt state.json or bad input still exits 0', () => {
    writeTask('TASK-101', 'mutation');
    fs.writeFileSync(path.join(project, 'specs', 'TASK-101', 'state.json'), '{nope');
    for (const input of ['{nope', '']) {
      const result = stop(input);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).systemMessage).toContain('Corrupt state.json');
    }
  });
});
