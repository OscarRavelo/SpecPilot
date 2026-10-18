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
const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

describe('specpilot CLI', () => {
  test('--help lists the v0.1 commands', () => {
    const result = run('--help');

    expect(result.status).toBe(0);
    for (const command of ['init', 'spec lint', 'ledger check', 'grill checklist', 'grill hash', 'hook pre-tool-use', 'hook stop', 'gate', 'reopen', 'tdd', 'mutate', 'verify', 'report', 'status']) {
      expect(result.stdout).toContain(command);
    }
  });

  test('--help lists mutate and mutate bug', () => {
    const result = run('--help');
    expect(result.stdout).toContain('mutate <task>');
    expect(result.stdout).toContain('mutate bug <task> AC-n');
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

  describe('--roles', () => {
    const hookWith = (args: string[], input: string) => {
      const { SPECPILOT_TASK, CLAUDE_PROJECT_DIR, ...rest } = process.env;
      return spawnSync(process.execPath, [BIN, 'hook', 'pre-tool-use', ...args], {
        encoding: 'utf8',
        cwd: project,
        input,
        env: rest,
      });
    };
    const writeAs = (file: string, agentType?: string) =>
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: path.join(project, file) },
        ...(agentType === undefined ? {} : { agent_type: agentType }),
      });

    test('the main session cannot write source code with --roles', () => {
      const result = hookWith(['--roles'], writeAs('src/users.ts'));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('only code-agent may edit source code (src/users.ts)');
    });

    test('code-agent can write source code with --roles', () => {
      const result = hookWith(['--roles'], writeAs('src/users.ts', 'code-agent'));
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    test('without --roles the main session can write source code', () => {
      const result = hookWith([], writeAs('src/users.ts'));
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    test('an unknown flag exits 1 with usage', () => {
      const result = hookWith(['--bogus'], writeAs('src/users.ts'));
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage: specpilot hook pre-tool-use');
    });

    test('--help lists the flag', () => {
      expect(run('--help').stdout).toContain('hook pre-tool-use [--roles]');
    });
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

describe('specpilot tdd', () => {
  const NODE_MODULES = path.join(__dirname, '..', 'node_modules');
  const ADDS_TEST = "const { sum } = require('../src/sum');\ntest('adds', () => { expect(sum(1, 2)).toBe(3); });\n";
  let project: string;
  const file = (name: string) => path.join(project, name);
  const writeState = (phase: string) =>
    fs.writeFileSync(file('specs/TASK-101/state.json'), JSON.stringify({ taskId: 'TASK-101', phase, history: [] }));
  const evidence = (stage: string) => JSON.parse(fs.readFileSync(file(`specs/TASK-101/${stage}.json`), 'utf8'));

  // A real project: Jest runs through npm test, as it would in a target project.
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-tdd-cli-'));
    fs.symlinkSync(NODE_MODULES, file('node_modules'));
    fs.writeFileSync(
      file('package.json'),
      JSON.stringify({ name: 'demo', private: true, scripts: { test: 'jest' }, jest: { testEnvironment: 'node' } }),
    );
    fs.mkdirSync(file('src'));
    fs.mkdirSync(file('test'));
    fs.mkdirSync(file('specs/TASK-101'), { recursive: true });
    fs.copyFileSync(path.join(SPECS, 'valid.md'), file('specs/TASK-101/spec.md'));
    fs.writeFileSync(file('src/sum.js'), 'exports.sum = () => 0;\n');
    fs.writeFileSync(file('test/sum.test.js'), ADDS_TEST);
    writeState('red');
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('tdd red records the tests that fail on assertions', () => {
    const result = runIn(project, 'tdd', 'red', 'TASK-101');
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('RED: TASK-101 (1 failing test, all on assertions)');
    expect(result.stdout).toContain('Next: specpilot gate TASK-101');
    expect(evidence('red')).toEqual({
      taskId: 'TASK-101',
      at: expect.any(String),
      tests: ['adds'],
      testFiles: { 'test/sum.test.js': expect.stringMatching(/^[0-9a-f]{64}$/) },
      sourceFiles: { 'src/sum.js': sha256('exports.sum = () => 0;\n') },
    });
  });

  test('tdd red fails when no test fails', () => {
    fs.writeFileSync(file('src/sum.js'), 'exports.sum = (a, b) => a + b;\n');
    const result = runIn(project, 'tdd', 'red', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TASK-101 is not red:');
    expect(result.stderr).toContain('No test fails');
    expect(fs.existsSync(file('specs/TASK-101/red.json'))).toBe(false);
  });

  test('tdd red fails when a suite does not even run', () => {
    fs.writeFileSync(file('test/broken.test.js'), "require('../src/missing');\ntest('x', () => {});\n");
    const result = runIn(project, 'tdd', 'red', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("test/broken.test.js failed to run: Cannot find module '../src/missing'");
  });

  test('tdd red fails when a test throws instead of failing an assertion', () => {
    fs.writeFileSync(file('test/sum.test.js'), "const { sum } = require('../src/sum');\ntest('throws', () => { sum.nope(); });\n");
    const result = runIn(project, 'tdd', 'red', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"throws" fails with an error, not an assertion: TypeError');
  });

  test('tdd only runs in its own phase', () => {
    writeState('plan');
    const red = runIn(project, 'tdd', 'red', 'TASK-101');
    expect(red.status).toBe(1);
    expect(red.stderr).toContain('TASK-101 is in plan: tdd red runs only in the red phase');
    const green = runIn(project, 'tdd', 'green', 'TASK-101');
    expect(green.stderr).toContain('TASK-101 is in plan: tdd green runs only in the green phase');
  });

  test('red → gate → green → gate, with real tests', () => {
    expect(runIn(project, 'tdd', 'red', 'TASK-101').status).toBe(0);
    expect(runIn(project, 'gate', 'TASK-101').stdout).toContain('TASK-101: red → green');

    fs.writeFileSync(file('src/sum.js'), 'exports.sum = (a, b) => a + b;\n');
    const green = runIn(project, 'tdd', 'green', 'TASK-101');
    expect(green.stderr).toBe('');
    expect(green.status).toBe(0);
    expect(green.stdout).toContain('GREEN: TASK-101 (1 test passes, tests unchanged since red)');
    expect(evidence('green')).toEqual({
      ...evidence('red'),
      at: expect.any(String),
      sourceFiles: { 'src/sum.js': sha256('exports.sum = (a, b) => a + b;\n') },
    });

    expect(runIn(project, 'gate', 'TASK-101').stdout).toContain('TASK-101: green → mutation');
  });

  test('tdd green fails while a test still fails', () => {
    expect(runIn(project, 'tdd', 'red', 'TASK-101').status).toBe(0);
    writeState('green');
    const result = runIn(project, 'tdd', 'green', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TASK-101 is not green:');
    expect(result.stderr).toContain('"adds" still fails');
    expect(fs.existsSync(file('specs/TASK-101/green.json'))).toBe(false);
  });

  test('tdd green fails when the tests changed since red', () => {
    expect(runIn(project, 'tdd', 'red', 'TASK-101').status).toBe(0);
    writeState('green');
    fs.writeFileSync(file('src/sum.js'), 'exports.sum = (a, b) => a + b;\n');
    fs.writeFileSync(file('test/sum.test.js'), ADDS_TEST.replace('toBe(3)', 'toBeGreaterThan(0)'));
    const result = runIn(project, 'tdd', 'green', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Tests changed since tdd red (changed test/sum.test.js)');
  });

  test('tdd green needs red.json', () => {
    writeState('green');
    const result = runIn(project, 'tdd', 'green', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing red.json: run specpilot tdd red TASK-101 first');
  });

  test('a test script that does not run Jest is reported', () => {
    fs.writeFileSync(file('package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'echo no tests' } }));
    const result = runIn(project, 'tdd', 'red', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm test did not write a Jest JSON report');
  });

  test.each([[['tdd']], [['tdd', 'red']], [['tdd', 'blue', 'TASK-101']]])('%j prints usage', (args) => {
    const result = runIn(project, ...args);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Usage: specpilot tdd red|green <task>');
  });

  test('tdd on a missing task exits 1', () => {
    const result = runIn(project, 'tdd', 'red', 'TASK-404');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No task TASK-404');
  });
});

describe('specpilot mutate', () => {
  const NODE_MODULES = path.join(__dirname, '..', 'node_modules');
  const RED_CODE = 'exports.sum = () => 0;\n';
  const GREEN_CODE = 'exports.sum = (a, b) => a + b;\n';
  const BUG_CODE = 'exports.sum = (a, b) => a - b;\n';
  const AC_TEST = "const { sum } = require('../src/sum');\ntest('AC-1 adds two numbers', () => { expect(sum(1, 2)).toBe(3); });\n";
  const UNNAMED_TEST = "const { sum } = require('../src/sum');\ntest('adds', () => { expect(sum(1, 2)).toBe(3); });\n";
  const INSTALL = 'npm i -D @stryker-mutator/core @stryker-mutator/jest-runner @stryker-mutator/typescript-checker';
  let project: string;
  const file = (name: string) => path.join(project, name);
  const writeState = (phase: string) =>
    fs.writeFileSync(file('specs/TASK-101/state.json'), JSON.stringify({ taskId: 'TASK-101', phase, history: [] }));
  const evidenceFor = (code: string, testCode: string, withSource = true) => ({
    taskId: 'TASK-101',
    at: '2026-10-18T10:00:00.000Z',
    tests: [],
    testFiles: { 'test/sum.test.js': sha256(testCode) },
    ...(withSource ? { sourceFiles: { 'src/sum.js': sha256(code) } } : {}),
  });
  // A task that went through red and green: red.json saw the stub, green.json the finished code.
  const setUp = (testCode: string, { greenSource = true } = {}) => {
    fs.mkdirSync(file('src'));
    fs.mkdirSync(file('test'));
    fs.mkdirSync(file('specs/TASK-101'), { recursive: true });
    fs.copyFileSync(path.join(SPECS, 'valid.md'), file('specs/TASK-101/spec.md'));
    fs.writeFileSync(file('src/sum.js'), GREEN_CODE);
    fs.writeFileSync(file('test/sum.test.js'), testCode);
    fs.writeFileSync(file('specs/TASK-101/red.json'), JSON.stringify(evidenceFor(RED_CODE, testCode)));
    fs.writeFileSync(file('specs/TASK-101/green.json'), JSON.stringify(evidenceFor(GREEN_CODE, testCode, greenSource)));
    writeState('mutation');
  };
  // Stands in for an installed Stryker: its `stryker` bin records each config in stryker-calls.json and
  // reports the mutants listed in stryker-mutants.json (see test/fixtures/stryker/fake-stryker.js).
  const fakeStryker = () => {
    const dir = file('node_modules/@stryker-mutator/core');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@stryker-mutator/core', version: '0.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
    fs.mkdirSync(file('node_modules/.bin'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'fixtures', 'stryker', 'fake-stryker.js'), file('node_modules/.bin/stryker'));
    fs.chmodSync(file('node_modules/.bin/stryker'), 0o755);
  };
  const mutation = () => {
    expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(true);
    return JSON.parse(fs.readFileSync(file('specs/TASK-101/mutation.json'), 'utf8'));
  };

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-mutate-cli-'));
    fs.writeFileSync(
      file('package.json'),
      JSON.stringify({ name: 'demo', private: true, scripts: { test: 'jest' }, jest: { testEnvironment: 'node' } }),
    );
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  describe('checks before running Stryker', () => {
    beforeEach(() => {
      setUp(AC_TEST);
      fakeStryker();
    });

    test.each([[['mutate']], [['mutate', 'bug']], [['mutate', 'bug', 'TASK-101']]])('%j prints usage', (args) => {
      const result = runIn(project, ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage: specpilot mutate');
    });

    test('mutate on a missing task exits 1', () => {
      const result = runIn(project, 'mutate', 'TASK-404');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('No task TASK-404');
    });

    test('mutate runs only in the mutation phase', () => {
      writeState('green');
      for (const args of [['mutate', 'TASK-101'], ['mutate', 'bug', 'TASK-101', 'AC-1']]) {
        const result = runIn(project, ...args);
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('TASK-101 is in green');
        expect(result.stderr).toContain('runs only in the mutation phase');
      }
      expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
    });

    test('mutate refuses source code that differs from green.json and names the file', () => {
      fs.writeFileSync(file('src/sum.js'), BUG_CODE);
      const result = runIn(project, 'mutate', 'TASK-101');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('src/sum.js');
      expect(result.stderr).toContain('green');
      expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
    });

    test('mutate refuses tests that differ from green.json and names the file', () => {
      fs.writeFileSync(file('test/sum.test.js'), UNNAMED_TEST);
      const result = runIn(project, 'mutate', 'TASK-101');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('test/sum.test.js');
    });

    test('mutate needs sourceFiles in green.json and asks to rerun tdd green', () => {
      fs.writeFileSync(file('specs/TASK-101/green.json'), JSON.stringify(evidenceFor(GREEN_CODE, AC_TEST, false)));
      const result = runIn(project, 'mutate', 'TASK-101');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('specpilot tdd green TASK-101');
    });

    test('mutate fails when the task changed no source code', () => {
      fs.writeFileSync(file('specs/TASK-101/red.json'), JSON.stringify(evidenceFor(GREEN_CODE, AC_TEST)));
      const result = runIn(project, 'mutate', 'TASK-101');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('no task code to mutate');
    });

    test('mutate bug needs an AC that is in the spec', () => {
      fs.writeFileSync(file('src/sum.js'), BUG_CODE);
      const result = runIn(project, 'mutate', 'bug', 'TASK-101', 'AC-9');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('AC-9');
      expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
    });

    test('mutate bug refuses source code identical to green.json: no bug was injected', () => {
      const result = runIn(project, 'mutate', 'bug', 'TASK-101', 'AC-1');
      expect(result.status).toBe(1);
      expect(result.stderr).toMatch(/no bug/i);
      expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
    });

    test('mutate bug refuses tests that differ from green.json', () => {
      fs.writeFileSync(file('src/sum.js'), BUG_CODE);
      fs.writeFileSync(file('test/sum.test.js'), UNNAMED_TEST);
      const result = runIn(project, 'mutate', 'bug', 'TASK-101', 'AC-1');
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('Tests changed after tdd green (changed test/sum.test.js): go back with specpilot reopen TASK-101 red\n');
      expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
    });

    test.each([[['mutate', 'TASK-101']], [['mutate', 'bug', 'TASK-101', 'AC-1']]])('%j needs green.json', (args) => {
      fs.rmSync(file('specs/TASK-101/green.json'));
      const result = runIn(project, ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('Missing green.json: run specpilot tdd green TASK-101 first\n');
    });

    test('mutate bug needs sourceFiles in green.json', () => {
      fs.writeFileSync(file('specs/TASK-101/green.json'), JSON.stringify(evidenceFor(GREEN_CODE, AC_TEST, false)));
      fs.writeFileSync(file('src/sum.js'), BUG_CODE);
      const result = runIn(project, 'mutate', 'bug', 'TASK-101', 'AC-1');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('green.json has no source file hashes');
      expect(result.stderr).toContain('specpilot tdd green TASK-101');
    });
  });

  // The stand-in Stryker answers instantly, so what mutate does with a report can be tested quickly.
  describe('mutate, with a stand-in Stryker', () => {
    const A_RED = 'exports.a = () => 0;\n';
    const A_GREEN = 'exports.a = (x) => x + 1;\n';
    const B_RED = 'exports.b = () => 0;\n';
    const B_GREEN = 'exports.b = (x) => x * 2;\n';
    const B_MUTANT = 'exports.b = (x) => x / 2;\n';
    const TEST = "test('AC-1 a', () => {});\ntest('AC-2 b', () => {});\n";
    const strykerMutant = (line: number, replacement: string, status: string) => ({
      id: String(line),
      mutatorName: 'ArithmeticOperator',
      replacement,
      status,
      location: { start: { line, column: 1 }, end: { line, column: 9 } },
    });
    const A_SURVIVOR = 'src/a.js:1 ArithmeticOperator x - 1';
    const B_SURVIVOR = 'src/b.js:1 ArithmeticOperator x / 2';
    const hashes = (files: Record<string, string>) =>
      Object.fromEntries(Object.entries(files).map(([name, text]) => [name, sha256(text)]));
    const writeEvidence = (stage: string, sourceFiles: Record<string, string>) =>
      fs.writeFileSync(
        file(`specs/TASK-101/${stage}.json`),
        JSON.stringify({ taskId: 'TASK-101', at: '2026-10-18T10:00:00.000Z', tests: [], testFiles: hashes({ 'test/ab.test.js': TEST }), sourceFiles: hashes(sourceFiles) }),
      );
    const writeMutation = (overrides: Record<string, unknown>) =>
      fs.writeFileSync(
        file('specs/TASK-101/mutation.json'),
        JSON.stringify({ taskId: 'TASK-101', at: '2026-10-18T10:10:00.000Z', sourceFiles: {}, testFiles: {}, mutants: [], bugs: [], ...overrides }),
      );
    const strykerReports = (plan: Record<string, unknown[]>) => fs.writeFileSync(file('stryker-mutants.json'), JSON.stringify(plan));
    const strykerCalls = () => JSON.parse(fs.readFileSync(file('stryker-calls.json'), 'utf8'));
    const equivalents = () => fs.readFileSync(file('specs/TASK-101/equivalents.md'), 'utf8');

    beforeEach(() => {
      fs.mkdirSync(file('src'));
      fs.mkdirSync(file('test'));
      fs.mkdirSync(file('specs/TASK-101'), { recursive: true });
      fs.copyFileSync(path.join(SPECS, 'valid.md'), file('specs/TASK-101/spec.md'));
      fs.writeFileSync(file('src/a.js'), A_GREEN);
      fs.writeFileSync(file('src/b.js'), B_GREEN);
      fs.writeFileSync(file('test/ab.test.js'), TEST);
      writeState('mutation');
      fakeStryker();
    });

    test('the first run mutates the files the task changed and records them', () => {
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_RED });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      strykerReports({ 'src/a.js': [strykerMutant(1, 'x - 1', 'Survived')], 'src/b.js': [strykerMutant(1, 'x / 2', 'Killed')] });

      const result = runIn(project, 'mutate', 'TASK-101');
      expect(result.status).toBe(1);
      expect([...strykerCalls()[0].mutate].sort()).toEqual(['src/a.js', 'src/b.js']);
      expect(mutation().files).toEqual(['src/a.js', 'src/b.js']);
    });

    // The reopen loop: after reopen, tdd red sees the earlier code with only the mutant put back in
    // b.js, so red and green differ only in b.js. a.js still has a survivor and must not be forgotten.
    test('after a reopen, files mutated before are mutated again and their survivors stay', () => {
      writeEvidence('red', { 'src/a.js': A_GREEN, 'src/b.js': B_MUTANT });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      writeMutation({
        sourceFiles: hashes({ 'src/a.js': A_GREEN, 'src/b.js': B_GREEN }),
        testFiles: hashes({ 'test/ab.test.js': "test('AC-1 a', () => {});\n" }),
        files: ['src/a.js', 'src/b.js'],
        mutants: [
          { id: A_SURVIVOR, file: 'src/a.js', line: 1, mutator: 'ArithmeticOperator', replacement: 'x - 1', status: 'Survived' },
          { id: B_SURVIVOR, file: 'src/b.js', line: 1, mutator: 'ArithmeticOperator', replacement: 'x / 2', status: 'Survived' },
        ],
      });
      strykerReports({ 'src/a.js': [strykerMutant(1, 'x - 1', 'Survived')], 'src/b.js': [strykerMutant(1, 'x / 2', 'Killed')] });

      const result = runIn(project, 'mutate', 'TASK-101');
      expect([...strykerCalls()[0].mutate].sort()).toEqual(['src/a.js', 'src/b.js']);
      expect(mutation().files).toEqual(['src/a.js', 'src/b.js']);
      expect(mutation().mutants.map((m: { id: string }) => m.id)).toContain(A_SURVIVOR);
      expect(equivalents()).toContain(`### ${A_SURVIVOR}`);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`✕ ${A_SURVIVOR} (Survived)`);
      expect(result.stderr).toContain('specpilot reopen TASK-101 red');
    });

    test('a mutation.json without a files list still brings back the files of its mutants', () => {
      writeEvidence('red', { 'src/a.js': A_GREEN, 'src/b.js': B_MUTANT });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      writeMutation({
        sourceFiles: hashes({ 'src/a.js': A_GREEN, 'src/b.js': B_GREEN }),
        mutants: [{ id: A_SURVIVOR, file: 'src/a.js', line: 1, mutator: 'ArithmeticOperator', replacement: 'x - 1', status: 'Survived' }],
      });

      runIn(project, 'mutate', 'TASK-101');
      expect([...strykerCalls()[0].mutate].sort()).toEqual(['src/a.js', 'src/b.js']);
    });

    test('a file mutated before stays in the set even if Stryker found no mutants in it', () => {
      writeEvidence('red', { 'src/a.js': A_GREEN, 'src/b.js': B_MUTANT });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      writeMutation({ sourceFiles: hashes({ 'src/a.js': A_GREEN, 'src/b.js': B_GREEN }), files: ['src/a.js', 'src/b.js'], mutants: [] });

      runIn(project, 'mutate', 'TASK-101');
      expect([...strykerCalls()[0].mutate].sort()).toEqual(['src/a.js', 'src/b.js']);
      expect(mutation().files).toEqual(['src/a.js', 'src/b.js']);
    });

    test('Pending, RuntimeError and Ignored mutants go to equivalents.md and fail mutate', () => {
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_GREEN });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      strykerReports({
        'src/a.js': [strykerMutant(1, 'x - 1', 'Pending'), strykerMutant(2, 'x * 1', 'RuntimeError'), strykerMutant(3, 'x / 1', 'Ignored')],
      });

      const result = runIn(project, 'mutate', 'TASK-101');
      for (const [line, replacement, status] of [[1, 'x - 1', 'Pending'], [2, 'x * 1', 'RuntimeError'], [3, 'x / 1', 'Ignored']]) {
        const id = `src/a.js:${line} ArithmeticOperator ${replacement}`;
        expect(equivalents()).toContain(`### ${id}\n- Approved: no`);
        expect(result.stderr).toContain(`✕ ${id} (${status})`);
      }
      expect(result.status).toBe(1);
    });

    test('keeps the targeted bugs already recorded', () => {
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_GREEN });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      const recorded = { ac: 'AC-1', caught: true, at: '2026-10-18T10:05:00.000Z', sourceFiles: {}, testFiles: {}, failing: ['AC-1 a'] };
      writeMutation({ bugs: [recorded] });

      expect(runIn(project, 'mutate', 'TASK-101').status).toBe(0);
      expect(mutation().bugs).toEqual([recorded]);
    });

    test('a project without tsconfig.json gets no TypeScript checker', () => {
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_GREEN });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      runIn(project, 'mutate', 'TASK-101');
      expect(strykerCalls()[0].checkers ?? []).toEqual([]);
    });

    test('a Stryker run that writes no report exits 1 without a stack trace', () => {
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_GREEN });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      fs.writeFileSync(file('stryker-mutants.json'), JSON.stringify('no-report'));
      const result = runIn(project, 'mutate', 'TASK-101');
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('Stryker did not write a JSON report: see its output above\n');
      expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
    });

    // A Stryker run that failed part way may still write a report, but it is not one to trust.
    const expectStrykerExitError = (result: { status: number | null; stderr: string }, code: number) => {
      expect(result.status).toBe(1);
      expect(result.stderr.endsWith('\n')).toBe(true);
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(result.stderr).toContain('Stryker');
      expect(result.stderr).toMatch(/exit/i);
      expect(result.stderr).toMatch(new RegExp(`\\b${code}\\b`));
    };

    test('a Stryker run that exits non-zero fails mutate even if it wrote a report, and writes no evidence', () => {
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_GREEN });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      strykerReports({ 'src/a.js': [strykerMutant(1, 'x - 1', 'Killed')] });
      fs.writeFileSync(file('stryker-exit.json'), '3');

      const result = runIn(project, 'mutate', 'TASK-101');
      expect(strykerCalls()).toHaveLength(1);
      expectStrykerExitError(result, 3);
      expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
      expect(fs.existsSync(file('specs/TASK-101/equivalents.md'))).toBe(false);
    });

    test('a Stryker run that exits non-zero leaves an earlier mutation.json and equivalents.md untouched', () => {
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_GREEN });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      writeMutation({
        sourceFiles: hashes({ 'src/a.js': A_GREEN, 'src/b.js': B_GREEN }),
        testFiles: hashes({ 'test/ab.test.js': TEST }),
        files: ['src/a.js'],
        mutants: [{ id: A_SURVIVOR, file: 'src/a.js', line: 1, mutator: 'ArithmeticOperator', replacement: 'x - 1', status: 'Survived' }],
      });
      const previousEquivalents = `# Equivalent mutants: TASK-101\n\n### ${A_SURVIVOR}\n- Approved: yes\n- Reason: checked by the human\n`;
      fs.writeFileSync(file('specs/TASK-101/equivalents.md'), previousEquivalents);
      const previousMutation = fs.readFileSync(file('specs/TASK-101/mutation.json'), 'utf8');
      strykerReports({ 'src/a.js': [strykerMutant(1, 'x - 1', 'Killed')] });
      fs.writeFileSync(file('stryker-exit.json'), '2');

      const result = runIn(project, 'mutate', 'TASK-101');
      expectStrykerExitError(result, 2);
      expect(fs.readFileSync(file('specs/TASK-101/mutation.json'), 'utf8')).toBe(previousMutation);
      expect(equivalents()).toBe(previousEquivalents);
    });
  });

  test('mutate says how to install Stryker when the project does not have it', () => {
    setUp(AC_TEST);
    const result = runIn(project, 'mutate', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(INSTALL);
  });

  // A real project: the targeted bug runs through npm test, as it would in a target project.
  describe('mutate bug, with real tests', () => {
    beforeEach(() => fs.symlinkSync(NODE_MODULES, file('node_modules')));

    test('a bug caught by a test named with the AC is recorded as caught', () => {
      setUp(AC_TEST);
      fs.writeFileSync(file('src/sum.js'), BUG_CODE);
      const result = runIn(project, 'mutate', 'bug', 'TASK-101', 'AC-1');
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('AC-1');
      expect(result.stdout).toContain('Now remove the bug: the code must be exactly what tdd green saw before specpilot gate TASK-101');
      // testFiles ties the bug to the tests of this green: a bug from an earlier round does not count.
      expect(mutation().bugs).toEqual([
        {
          ac: 'AC-1',
          caught: true,
          at: expect.any(String),
          sourceFiles: { 'src/sum.js': sha256(BUG_CODE) },
          testFiles: { 'test/sum.test.js': sha256(AC_TEST) },
          failing: ['AC-1 adds two numbers'],
        },
      ]);
    });

    test('a bug caught only by a test without the AC in its name is recorded as not caught', () => {
      setUp(UNNAMED_TEST);
      fs.writeFileSync(file('src/sum.js'), BUG_CODE);
      const result = runIn(project, 'mutate', 'bug', 'TASK-101', 'AC-1');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('NOT CAUGHT: the bug for AC-1 in TASK-101 is a test gap:');
      expect(result.stderr).toContain('No test with AC-1 in its name fails on an assertion');
      expect(result.stderr).toContain('specpilot reopen TASK-101 red');
      expect(mutation().bugs).toEqual([
        expect.objectContaining({ ac: 'AC-1', caught: false, failing: ['adds'], testFiles: { 'test/sum.test.js': sha256(UNNAMED_TEST) } }),
      ]);
    });

    test('each targeted bug is added to the ones already in mutation.json', () => {
      setUp(AC_TEST);
      fs.writeFileSync(file('src/sum.js'), BUG_CODE);
      expect(runIn(project, 'mutate', 'bug', 'TASK-101', 'AC-1').status).toBe(0);
      expect(runIn(project, 'mutate', 'bug', 'TASK-101', 'AC-2').status).toBe(1);
      expect(mutation().bugs.map((record: { ac: string; caught: boolean }) => [record.ac, record.caught])).toEqual([
        ['AC-1', true],
        ['AC-2', false],
      ]);
    });

    test('a bug that does not even load is not counted as caught', () => {
      setUp(AC_TEST);
      fs.writeFileSync(file('src/sum.js'), 'exports.sum = (a, b) => a +;\n');
      const result = runIn(project, 'mutate', 'bug', 'TASK-101', 'AC-1');
      expect(result.status).toBe(1);
      expect(mutation().bugs).toEqual([expect.objectContaining({ ac: 'AC-1', caught: false })]);
    });
  });

  // Real Stryker, from this repo's node_modules (symlinked into the project), over a plain-JS project
  // without tsconfig.json. Zero is never tested, so "n >= 0" is the one mutant that survives.
  describe('mutate, with real Stryker', () => {
    const POSITIVE_RED = 'exports.isPositive = () => false;\n';
    const POSITIVE = 'exports.isPositive = (n) => n > 0;\n';
    const POSITIVE_TEST = [
      "const { isPositive } = require('../src/positive');",
      "test('AC-1 five is positive', () => { expect(isPositive(5)).toBe(true); });",
      "test('AC-2 minus one is not positive', () => { expect(isPositive(-1)).toBe(false); });",
      '',
    ].join('\n');
    const SURVIVOR = 'src/positive.js:1 EqualityOperator n >= 0';
    const evidence = (code: string) => ({
      taskId: 'TASK-101',
      at: '2026-10-18T10:00:00.000Z',
      tests: [],
      testFiles: { 'test/positive.test.js': sha256(POSITIVE_TEST) },
      sourceFiles: { 'src/positive.js': sha256(code) },
    });
    const headings = (text: string) => text.split('\n').filter((line) => line.startsWith('### '));

    beforeEach(() => {
      fs.symlinkSync(NODE_MODULES, file('node_modules'));
      fs.mkdirSync(file('src'));
      fs.mkdirSync(file('test'));
      fs.mkdirSync(file('specs/TASK-101'), { recursive: true });
      fs.copyFileSync(path.join(SPECS, 'valid.md'), file('specs/TASK-101/spec.md'));
      fs.writeFileSync(file('src/positive.js'), POSITIVE);
      fs.writeFileSync(file('test/positive.test.js'), POSITIVE_TEST);
      fs.writeFileSync(file('specs/TASK-101/red.json'), JSON.stringify(evidence(POSITIVE_RED)));
      fs.writeFileSync(file('specs/TASK-101/green.json'), JSON.stringify(evidence(POSITIVE)));
      writeState('mutation');    });

    test(
      'a weak test leaves a survivor; once the human approves it, mutate keeps the approval and passes',
      () => {
        const first = runIn(project, 'mutate', 'TASK-101');
        const equivalentsFile = file('specs/TASK-101/equivalents.md');
        expect(fs.existsSync(equivalentsFile)).toBe(true);

        const { mutants } = mutation();
        expect(mutants.length).toBeGreaterThan(1);
        const survived = mutants.filter((m: { status: string }) => m.status === 'Survived').map((m: { id: string }) => m.id);
        expect(survived).toEqual([SURVIVOR]);
        expect(headings(fs.readFileSync(equivalentsFile, 'utf8'))).toEqual([`### ${SURVIVOR}`]);
        expect(first.status).toBe(1);
        expect(first.stderr).toContain(`✕ ${SURVIVOR} (Survived)`);
        expect(first.stderr).toContain('specpilot reopen TASK-101 red');

        // Only the human approves an equivalent; here the test plays the human.
        fs.writeFileSync(
          equivalentsFile,
          fs.readFileSync(equivalentsFile, 'utf8').replace('- Approved: no', '- Approved: yes').replace('- Reason: ', '- Reason: zero is out of scope'),
        );
        const second = runIn(project, 'mutate', 'TASK-101');
        expect(second.stderr).not.toContain(SURVIVOR);
        expect(second.status).toBe(0);
        expect(second.stdout).toContain('Next: inject a bug for each AC and run specpilot mutate bug TASK-101 AC-n, then specpilot gate TASK-101');
        const kept = fs.readFileSync(equivalentsFile, 'utf8');
        expect(kept).toContain(`### ${SURVIVOR}\n- Approved: yes\n- Reason: zero is out of scope`);
        expect(fs.existsSync(file('.stryker-tmp'))).toBe(false);
      },
      240_000,
    );
  });
});
