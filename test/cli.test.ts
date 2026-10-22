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

  test('AC-7: report and verify are no longer commands that are not implemented yet', () => {
    expect(run('report').stderr).not.toContain('is not implemented yet');
    expect(run('verify').stderr).not.toContain('not implemented');
  });

  test('--help lists verify <task>', () => {
    expect(run('--help').stdout.split('\n')).toContain(
      '  verify <task>           Run the tests again and check every AC is covered; if so, move to done',
    );
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
  // mutate matches each file with the minimatch that the installed Stryker loads, so the minimatch real
  // Stryker resolves in this repo is linked next to the stand-in.
  const STRYKER_MINIMATCH = path.dirname(
    require.resolve('minimatch/package.json', { paths: [path.join(NODE_MODULES, '@stryker-mutator', 'core')] }),
  );
  const fakeStryker = () => {
    const dir = file('node_modules/@stryker-mutator/core');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: '@stryker-mutator/core', version: '0.0.0', main: 'index.js' }));
    fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {};\n');
    fs.symlinkSync(STRYKER_MINIMATCH, file('node_modules/minimatch'), 'dir');
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
    // A file planned as null is left out of the report, as real Stryker leaves out a types-only file.
    const strykerReports = (plan: Record<string, unknown[] | null>) => fs.writeFileSync(file('stryker-mutants.json'), JSON.stringify(plan));
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

    // disableTypeChecks lists the mutated files in a {a,b} glob, which cannot hold a "," "{" or "}".
    test('a changed file with a comma in its path stops mutate before Stryker starts and asks to rename it', () => {
      fs.rmSync(file('src/a.js'));
      fs.writeFileSync(file('src/a,b.js'), A_GREEN);
      writeEvidence('red', { 'src/a,b.js': A_RED, 'src/b.js': B_GREEN });
      writeEvidence('green', { 'src/a,b.js': A_GREEN, 'src/b.js': B_GREEN });
      strykerReports({ 'src/a,b.js': [strykerMutant(1, 'x - 1', 'Killed')] });

      const result = runIn(project, 'mutate', 'TASK-101');
      expect(fs.existsSync(file('stryker-calls.json'))).toBe(false);
      expect(result.status).toBe(1);
      expect(result.stderr.endsWith('\n')).toBe(true);
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(result.stderr).toContain('src/a,b.js');
      expect(result.stderr).toMatch(/rename/);
      expect(result.stderr).toContain('specpilot reopen TASK-101 red');
      expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
    });

    // Stryker never lists files under a folder whose name starts with ".", so it would mutate nothing there.
    test('a changed file in a hidden folder stops mutate before Stryker starts and says how to continue', () => {
      fs.rmSync(file('src/a.js'));
      fs.mkdirSync(file('src/.x'));
      fs.writeFileSync(file('src/.x/a.js'), A_GREEN);
      writeEvidence('red', { 'src/.x/a.js': A_RED, 'src/b.js': B_GREEN });
      writeEvidence('green', { 'src/.x/a.js': A_GREEN, 'src/b.js': B_GREEN });
      strykerReports({ 'src/.x/a.js': [strykerMutant(1, 'x - 1', 'Killed')] });

      const result = runIn(project, 'mutate', 'TASK-101');
      expect(fs.existsSync(file('stryker-calls.json'))).toBe(false);
      expect(result.status).toBe(1);
      expect(result.stderr.endsWith('\n')).toBe(true);
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(result.stderr).toContain('src/.x/a.js');
      expect(result.stderr).toMatch(/hidden/);
      expect(result.stderr).toContain('specpilot reopen TASK-101 red');
      expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
    });

    // Real Stryker's FileMatcher resolves each mutate entry against the project root without escaping
    // the root, so "[x]" in a folder above the files is a character class and the entry matches nothing.
    test('a project root inside a folder with "[x]" in its name stops mutate before Stryker starts and names the file', () => {
      const outer = project;
      const inside = path.join(outer, 'dir[x]', 'app');
      fs.mkdirSync(inside, { recursive: true });
      for (const entry of fs.readdirSync(outer)) {
        if (entry !== 'dir[x]') fs.renameSync(path.join(outer, entry), path.join(inside, entry));
      }
      project = inside;
      try {
        writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_GREEN });
        writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
        strykerReports({ 'src/a.js': [strykerMutant(1, 'x - 1', 'Killed')] });

        const result = runIn(project, 'mutate', 'TASK-101');
        expect(fs.existsSync(file('stryker-calls.json'))).toBe(false);
        expect(result.status).toBe(1);
        expect(result.stderr.endsWith('\n')).toBe(true);
        expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
        expect(result.stderr).toContain('src/a.js');
        // The CLI's root is process.cwd(), which resolves symlinks such as macOS's /var -> /private/var.
        expect(result.stderr).toBe(
          `Stryker would skip src/a.js: its mutate entry src/a.js does not match it, because Stryker reads ` +
            `the project root ${fs.realpathSync(inside)} as a glob: move the project to a path without glob characters\n`,
        );
        expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
        expect(fs.existsSync(file('specs/TASK-101/equivalents.md'))).toBe(false);
      } finally {
        project = outer;
      }
    });

    // Older minimatch versions export the function itself instead of { minimatch }; mutate must call it.
    // This stand-in matches nothing, so mutate stops before Stryker even though the root is a normal path,
    // and the message does not blame the root: it has no glob characters.
    test('an older minimatch that exports a function is the one mutate uses', () => {
      fs.unlinkSync(file('node_modules/minimatch'));
      fs.mkdirSync(file('node_modules/minimatch'));
      fs.writeFileSync(file('node_modules/minimatch/package.json'), JSON.stringify({ name: 'minimatch', version: '3.0.0', main: 'index.js' }));
      fs.writeFileSync(file('node_modules/minimatch/index.js'), 'module.exports = () => false;\n');
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_GREEN });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      strykerReports({ 'src/a.js': [strykerMutant(1, 'x - 1', 'Killed')] });

      const result = runIn(project, 'mutate', 'TASK-101');
      expect(fs.existsSync(file('stryker-calls.json'))).toBe(false);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe('Stryker would skip src/a.js: its mutate entry src/a.js does not match it\n');
      expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
    });

    // Real Stryker leaves a file with nothing to mutate (only types) out of its report: that is not an error.
    test('a task file Stryker leaves out of its report passes mutate with a "no mutants" notice and is recorded', () => {
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_RED });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      strykerReports({ 'src/a.js': [strykerMutant(1, 'x - 1', 'Killed')], 'src/b.js': null });

      const result = runIn(project, 'mutate', 'TASK-101');
      expect(result.stdout).toContain('no mutants: src/b.js');
      expect(result.stdout).not.toContain('no mutants: src/a.js');
      expect(result.status).toBe(0);
      expect(mutation().noMutants).toEqual(['src/b.js']);
      expect(mutation().files).toEqual(['src/a.js', 'src/b.js']);
      expect(result.stdout).toContain('no mutants: src/b.js\nMUTATION: TASK-101 ');
    });

    test('several task files left out of the report are recorded and printed in sorted order', () => {
      const C_RED = 'exports.c = () => 0;\n';
      const C_GREEN = 'exports.c = (x) => x - 3;\n';
      fs.writeFileSync(file('src/c.js'), C_GREEN);
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_RED, 'src/c.js': C_RED });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN, 'src/c.js': C_GREEN });
      strykerReports({ 'src/c.js': null, 'src/b.js': null, 'src/a.js': [strykerMutant(1, 'x - 1', 'Killed')] });

      const result = runIn(project, 'mutate', 'TASK-101');
      expect(result.status).toBe(0);
      expect(mutation().noMutants).toEqual(['src/b.js', 'src/c.js']);
      expect(result.stdout).toContain('no mutants: src/b.js\nno mutants: src/c.js\nMUTATION: TASK-101 ');
    });

    test('a run where Stryker reports every task file records noMutants as [] and prints no "no mutants" line', () => {
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_RED });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      strykerReports({ 'src/a.js': [strykerMutant(1, 'x - 1', 'Killed')], 'src/b.js': [strykerMutant(1, 'x / 2', 'Killed')] });

      const result = runIn(project, 'mutate', 'TASK-101');
      expect(result.status).toBe(0);
      expect(mutation().noMutants).toEqual([]);
      expect(result.stdout).not.toContain('no mutants:');
    });

    test('mutate fails when Stryker leaves every task file out of its report, and writes no evidence', () => {
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_RED });
      writeEvidence('green', { 'src/a.js': A_GREEN, 'src/b.js': B_GREEN });
      strykerReports({ 'src/a.js': null, 'src/b.js': null });

      const result = runIn(project, 'mutate', 'TASK-101');
      expect(strykerCalls()).toHaveLength(1);
      expect(result.status).toBe(1);
      expect(result.stderr.endsWith('\n')).toBe(true);
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(result.stderr).toBe('Stryker reported none of the task files (src/a.js, src/b.js): see its output above\n');
      expect(result.stdout).not.toContain('no mutants:');
      expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(false);
      expect(fs.existsSync(file('specs/TASK-101/equivalents.md'))).toBe(false);
    });

    test('mutate fails when Stryker leaves every task file out of its report, and leaves an earlier mutation.json and equivalents.md untouched', () => {
      writeEvidence('red', { 'src/a.js': A_RED, 'src/b.js': B_RED });
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
      strykerReports({ 'src/a.js': null, 'src/b.js': null });

      const result = runIn(project, 'mutate', 'TASK-101');
      expect(result.status).toBe(1);
      expect(result.stderr.endsWith('\n')).toBe(true);
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(fs.readFileSync(file('specs/TASK-101/mutation.json'), 'utf8')).toBe(previousMutation);
      expect(equivalents()).toBe(previousEquivalents);
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

  // Stryker adds "// @ts-nocheck" to the files disableTypeChecks matches. A test that reads a fixture under
  // test/ breaks in Stryker's initial test run if the fixture gets that line too, so only mutated files may.
  describe('mutate, with real Stryker and a test that reads a fixture', () => {
    const DOUBLE_RED = 'exports.double = () => 0;\n';
    const DOUBLE = 'exports.double = (n) => n * 2;\n';
    const FIXTURE = "module.exports = 'first line of the fixture';\n";
    const DOUBLE_TEST = [
      "const fs = require('fs');",
      "const path = require('path');",
      "const { double } = require('../src/double');",
      "test('AC-1 two doubled is four', () => { expect(double(2)).toBe(4); });",
      "test('AC-2 the fixture starts with its own first line', () => {",
      "  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'data.js'), 'utf8');",
      "  expect(text.split('\\n')[0]).toBe(\"module.exports = 'first line of the fixture';\");",
      '});',
      '',
    ].join('\n');
    const evidence = (code: string) => ({
      taskId: 'TASK-101',
      at: '2026-10-18T10:00:00.000Z',
      tests: [],
      testFiles: { 'test/double.test.js': sha256(DOUBLE_TEST), 'test/fixtures/data.js': sha256(FIXTURE) },
      sourceFiles: { 'src/double.js': sha256(code) },
    });

    beforeEach(() => {
      fs.symlinkSync(NODE_MODULES, file('node_modules'));
      fs.mkdirSync(file('src'));
      fs.mkdirSync(file('test/fixtures'), { recursive: true });
      fs.mkdirSync(file('specs/TASK-101'), { recursive: true });
      fs.copyFileSync(path.join(SPECS, 'valid.md'), file('specs/TASK-101/spec.md'));
      fs.writeFileSync(file('src/double.js'), DOUBLE);
      fs.writeFileSync(file('test/double.test.js'), DOUBLE_TEST);
      fs.writeFileSync(file('test/fixtures/data.js'), FIXTURE);
      fs.writeFileSync(file('specs/TASK-101/red.json'), JSON.stringify(evidence(DOUBLE_RED)));
      fs.writeFileSync(file('specs/TASK-101/green.json'), JSON.stringify(evidence(DOUBLE)));
      writeState('mutation');
    });

    test(
      'the fixture keeps its line numbers in Stryker\'s sandbox, so the initial test run passes and mutate writes mutation.json',
      () => {
        const result = runIn(project, 'mutate', 'TASK-101');
        const output = `${result.stdout}\n${result.stderr}`;
        expect(output).not.toContain('failed tests in the initial test run');
        expect(fs.existsSync(file('specs/TASK-101/mutation.json'))).toBe(true);
        const { mutants } = mutation();
        expect(mutants.length).toBeGreaterThan(0);
        if (result.status !== 0) {
          expect(result.status).toBe(1);
          // Exit 1 is fine only because of surviving mutants, each listed by its id.
          expect(result.stderr).toMatch(/✕ src\/double\.js:\d+ /);
        }
        // The fixture in the project itself is never touched.
        expect(fs.readFileSync(file('test/fixtures/data.js'), 'utf8')).toBe(FIXTURE);
      },
      240_000,
    );
  });
});

// A real project in verify: npm test runs Jest, and the evidence of tdd red, tdd green and mutation
// passes the mutation gate, so what verify adds is the fresh test run and AC coverage.
describe('specpilot verify', () => {
  const NODE_MODULES = path.join(__dirname, '..', 'node_modules');
  const RED_CODE = 'exports.sum = () => 0;\n';
  const GREEN_CODE = 'exports.sum = (a, b) => a + b;\n';
  const BUG_CODE = 'exports.sum = (a, b) => a - b;\n';
  const COVERED_TEST = [
    "const { sum } = require('../src/sum');",
    "test('AC-1 adds two numbers', () => { expect(sum(1, 2)).toBe(3); });",
    "test('AC-1 adds a negative number', () => { expect(sum(1, -2)).toBe(-1); });",
    "test('AC-2: adds zero', () => { expect(sum(5, 0)).toBe(5); });",
    "test('keeps the other number AC-2.', () => { expect(sum(0, 7)).toBe(7); });",
    '',
  ].join('\n');
  // AC-2 is only named as part of other ids, so nothing covers it.
  const UNCOVERED_TEST = [
    "const { sum } = require('../src/sum');",
    "test('AC-1 adds two numbers', () => { expect(sum(1, 2)).toBe(3); });",
    "test('AC-1 adds a negative number', () => { expect(sum(1, -2)).toBe(-1); });",
    "test('AC-21 adds zero', () => { expect(sum(5, 0)).toBe(5); });",
    "test('AC-2.1 keeps the other number', () => { expect(sum(0, 7)).toBe(7); });",
    '',
  ].join('\n');
  const HALLUCINATIONS = 'specs/TASK-101/hallucinations.json';
  let project: string;
  const file = (name: string) => path.join(project, name);
  const writeState = (phase: string) =>
    fs.writeFileSync(file('specs/TASK-101/state.json'), JSON.stringify({ taskId: 'TASK-101', phase, history: [] }));
  const phaseOf = () => JSON.parse(fs.readFileSync(file('specs/TASK-101/state.json'), 'utf8')).phase;
  const hallucinations = () => {
    expect(fs.existsSync(file(HALLUCINATIONS))).toBe(true);
    return JSON.parse(fs.readFileSync(file(HALLUCINATIONS), 'utf8'));
  };
  const evidence = (code: string, testCode: string) => ({
    taskId: 'TASK-101',
    at: '2026-10-18T10:00:00.000Z',
    tests: [],
    testFiles: { 'test/sum.test.js': sha256(testCode) },
    sourceFiles: { 'src/sum.js': sha256(code) },
  });
  const caughtBug = (ac: string, testCode: string) => ({
    ac,
    caught: true,
    at: '2026-10-18T10:05:00.000Z',
    sourceFiles: { 'src/sum.js': sha256(BUG_CODE) },
    testFiles: { 'test/sum.test.js': sha256(testCode) },
    failing: [`${ac} adds two numbers`],
  });
  // A task that went through red, green and mutation with these tests: every mutant killed and a caught
  // bug for each AC after tdd green.
  const setUp = (testCode: string) => {
    fs.writeFileSync(file('test/sum.test.js'), testCode);
    fs.writeFileSync(file('specs/TASK-101/red.json'), JSON.stringify(evidence(RED_CODE, testCode)));
    fs.writeFileSync(file('specs/TASK-101/green.json'), JSON.stringify(evidence(GREEN_CODE, testCode)));
    fs.writeFileSync(
      file('specs/TASK-101/mutation.json'),
      JSON.stringify({
        taskId: 'TASK-101',
        at: '2026-10-18T10:10:00.000Z',
        sourceFiles: { 'src/sum.js': sha256(GREEN_CODE) },
        testFiles: { 'test/sum.test.js': sha256(testCode) },
        files: ['src/sum.js'],
        noMutants: [],
        mutants: [
          { id: 'src/sum.js:1 ArithmeticOperator a - b', file: 'src/sum.js', line: 1, mutator: 'ArithmeticOperator', replacement: 'a - b', status: 'Killed' },
        ],
        bugs: [caughtBug('AC-1', testCode), caughtBug('AC-2', testCode)],
      }),
    );
    writeState('verify');
  };

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-verify-cli-'));
    fs.symlinkSync(NODE_MODULES, file('node_modules'));
    fs.writeFileSync(
      file('package.json'),
      JSON.stringify({ name: 'demo', private: true, scripts: { test: 'jest' }, jest: { testEnvironment: 'node' } }),
    );
    fs.mkdirSync(file('src'));
    fs.mkdirSync(file('test'));
    fs.mkdirSync(file('specs/TASK-101'), { recursive: true });
    fs.copyFileSync(path.join(SPECS, 'valid.md'), file('specs/TASK-101/spec.md'));
    fs.writeFileSync(file('src/sum.js'), GREEN_CODE);
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('a task whose tests pass and cover every AC moves to done', () => {
    setUp(COVERED_TEST);
    const result = runIn(project, 'verify', 'TASK-101');
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      ['  ✓ AC-1 (2 tests)', '  ✓ AC-2 (2 tests)', 'VERIFY: TASK-101 passed', 'TASK-101: verify → done', ''].join('\n'),
    );
    expect(result.status).toBe(0);
    expect(phaseOf()).toBe('done');
    expect(fs.existsSync(file(HALLUCINATIONS))).toBe(false);
  });

  test('an AC without a passing test that names it blocks verify and is recorded as a hallucination', () => {
    setUp(UNCOVERED_TEST);
    const result = runIn(project, 'verify', 'TASK-101');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      [
        'VERIFY: TASK-101 blocked, recorded as a hallucination in specs/TASK-101/hallucinations.json',
        '  - AC-2 has no test that covers it',
        'Go back with specpilot reopen TASK-101 red',
        '',
      ].join('\n'),
    );
    expect(result.status).toBe(1);
    expect(phaseOf()).toBe('verify');
    expect(hallucinations()).toEqual([
      { taskId: 'TASK-101', at: expect.any(String), phase: 'verify', reasons: ['AC-2 has no test that covers it'] },
    ]);
    expect(Number.isNaN(Date.parse(hallucinations()[0].at))).toBe(false);
    const entry = { taskId: 'TASK-101', at: hallucinations()[0].at, phase: 'verify', reasons: ['AC-2 has no test that covers it'] };
    expect(fs.readFileSync(file(HALLUCINATIONS), 'utf8')).toBe(`${JSON.stringify([entry], null, 2)}\n`);
  });

  test('every blocked run is appended to hallucinations.json', () => {
    setUp(UNCOVERED_TEST);
    expect(runIn(project, 'verify', 'TASK-101').status).toBe(1);
    expect(runIn(project, 'verify', 'TASK-101').status).toBe(1);
    expect(hallucinations()).toHaveLength(2);
    for (const entry of hallucinations()) {
      expect(entry).toEqual({ taskId: 'TASK-101', at: expect.any(String), phase: 'verify', reasons: ['AC-2 has no test that covers it'] });
    }
    expect(phaseOf()).toBe('verify');
  }, 30_000);

  test('a bug left in the code blocks verify through the mutation gate and the failing tests', () => {
    setUp(COVERED_TEST);
    fs.writeFileSync(file('src/sum.js'), BUG_CODE);
    const result = runIn(project, 'verify', 'TASK-101');
    expect(result.status).toBe(1);
    const lines = result.stderr.split('\n');
    expect(lines[0]).toBe('VERIFY: TASK-101 blocked, recorded as a hallucination in specs/TASK-101/hallucinations.json');
    expect(lines).toContain('  - Source code differs from tdd green (changed src/sum.js): remove the injected bug');
    expect(lines).toContain('  - "AC-1 adds two numbers" still fails');
    expect(lines).toContain('  - AC-1 has no test that covers it');
    expect(result.stderr.endsWith('Go back with specpilot reopen TASK-101 red\n')).toBe(true);
    expect(phaseOf()).toBe('verify');
    expect(hallucinations()[0].reasons).toEqual(
      expect.arrayContaining([
        'Source code differs from tdd green (changed src/sum.js): remove the injected bug',
        '"AC-1 adds two numbers" still fails',
        'AC-1 has no test that covers it',
      ]),
    );
  });

  test('gate in verify fails and points to specpilot verify', () => {
    setUp(COVERED_TEST);
    const result = runIn(project, 'gate', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run specpilot verify TASK-101');
    expect(phaseOf()).toBe('verify');
  });

  // Cannot run: exit 2, one stderr line, nothing recorded.
  const expectCannotRun = (result: { status: number | null; stdout: string; stderr: string }) => {
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.endsWith('\n')).toBe(true);
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(fs.existsSync(file(HALLUCINATIONS))).toBe(false);
  };

  test('verify without a task prints usage and exits 2', () => {
    setUp(COVERED_TEST);
    const result = runIn(project, 'verify');
    expectCannotRun(result);
    expect(result.stderr).toContain('Usage: specpilot verify <task>');
  });

  test('verify on a missing task exits 2', () => {
    setUp(COVERED_TEST);
    const result = runIn(project, 'verify', 'TASK-404');
    expectCannotRun(result);
    expect(result.stderr).toContain('No task TASK-404');
  });

  test.each(['mutation', 'green', 'done'])('verify on a task in %s exits 2 and leaves the phase alone', (phase) => {
    setUp(UNCOVERED_TEST);
    writeState(phase);
    const result = runIn(project, 'verify', 'TASK-101');
    expectCannotRun(result);
    expect(result.stderr).toBe(`TASK-101 is in ${phase}: specpilot verify runs only in the verify phase\n`);
    expect(phaseOf()).toBe(phase);
  });

  // A corrupt hallucinations.json is caught before the tests run: exit 2, one line, the file untouched.
  const CORRUPT_HALLUCINATIONS = 'Corrupt hallucinations.json in specs/TASK-101\n';
  const expectCorruptHallucinations = (result: { status: number | null; stdout: string; stderr: string }, text: string) => {
    expect(result.stderr).toBe(CORRUPT_HALLUCINATIONS);
    expect(result.stdout).toBe('');
    expect(result.status).toBe(2);
    expect(fs.readFileSync(file(HALLUCINATIONS), 'utf8')).toBe(text);
    expect(phaseOf()).toBe('verify');
  };

  test('a hallucinations.json that is not JSON stops verify with exit 2, even when the task would pass', () => {
    setUp(COVERED_TEST);
    const text = '[{"taskId": "TASK-101",';
    fs.writeFileSync(file(HALLUCINATIONS), text);
    expectCorruptHallucinations(runIn(project, 'verify', 'TASK-101'), text);
  });

  test('a hallucinations.json that is not an array stops verify with exit 2, even when the task would be blocked', () => {
    setUp(UNCOVERED_TEST);
    const text = '{"taskId": "TASK-101", "reasons": []}\n';
    fs.writeFileSync(file(HALLUCINATIONS), text);
    expectCorruptHallucinations(runIn(project, 'verify', 'TASK-101'), text);
  });

  test('a corrupt hallucinations.json is caught before the tests run', () => {
    const marker = file('tests-ran.txt');
    const markingTest = [
      "require('fs').writeFileSync(" + JSON.stringify(marker) + ", 'ran');",
      COVERED_TEST,
    ].join('\n');
    setUp(markingTest);
    fs.writeFileSync(file(HALLUCINATIONS), '');
    expectCorruptHallucinations(runIn(project, 'verify', 'TASK-101'), '');
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('a corrupt or unreadable state.json makes verify exit 2 with one line, while gate and status keep exit 1', () => {
    setUp(COVERED_TEST);
    const stateFile = file('specs/TASK-101/state.json');
    const corrupt = () => fs.writeFileSync(stateFile, '{"taskId": "TASK-101", "phase": ');
    // A directory where state.json should be cannot be read.
    const unreadable = () => {
      fs.rmSync(stateFile);
      fs.mkdirSync(stateFile);
    };
    for (const breakState of [corrupt, unreadable]) {
      breakState();
      const result = runIn(project, 'verify', 'TASK-101');
      expectCannotRun(result);
      expect(result.stderr).toBe('Corrupt state.json in specs/TASK-101\n');

      for (const args of [['gate', 'TASK-101'], ['status']]) {
        const other = runIn(project, ...args);
        expect(other.stderr).toBe('Corrupt state.json in specs/TASK-101\n');
        expect(other.status).toBe(1);
      }
      expect(fs.existsSync(file(HALLUCINATIONS))).toBe(false);
    }
  }, 30_000);

  test('a spec with no acceptance criteria blocks verify and is recorded as a hallucination', () => {
    setUp(COVERED_TEST);
    const spec = fs.readFileSync(path.join(SPECS, 'valid.md'), 'utf8');
    fs.writeFileSync(file('specs/TASK-101/spec.md'), spec.slice(0, spec.indexOf('### AC-1')));
    const result = runIn(project, 'verify', 'TASK-101');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      [
        'VERIFY: TASK-101 blocked, recorded as a hallucination in specs/TASK-101/hallucinations.json',
        '  - The spec has no acceptance criteria',
        'Go back with specpilot reopen TASK-101 red',
        '',
      ].join('\n'),
    );
    expect(result.status).toBe(1);
    expect(phaseOf()).toBe('verify');
    expect(hallucinations()).toEqual([
      { taskId: 'TASK-101', at: expect.any(String), phase: 'verify', reasons: ['The spec has no acceptance criteria'] },
    ]);
  });

  test('a spec.md that cannot be read makes verify exit 2 with one line', () => {
    setUp(COVERED_TEST);
    fs.rmSync(file('specs/TASK-101/spec.md'));
    const result = runIn(project, 'verify', 'TASK-101');
    expectCannotRun(result);
    expect(result.stderr.startsWith('Cannot read specs/TASK-101/spec.md: ')).toBe(true);
    expect(phaseOf()).toBe('verify');
  });

  test('a test script that writes no Jest report makes verify exit 2 with one line', () => {
    setUp(COVERED_TEST);
    fs.writeFileSync(file('package.json'), JSON.stringify({ name: 'demo', private: true, scripts: { test: 'node -e ""' } }));
    const result = runIn(project, 'verify', 'TASK-101');
    expectCannotRun(result);
    expect(result.stderr).toBe(
      'npm test did not write a Jest JSON report: the "test" script must run jest (e.g. "jest" or "tsc && jest")\n',
    );
    expect(phaseOf()).toBe('verify');
  });

  test('a failing test blocks verify even when its AC is covered by another test', () => {
    setUp(`${COVERED_TEST}test('AC-2 adds zero twice', () => { expect(sum(0, 0)).toBe(1); });\n`);
    const result = runIn(project, 'verify', 'TASK-101');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      [
        'VERIFY: TASK-101 blocked, recorded as a hallucination in specs/TASK-101/hallucinations.json',
        '  - "AC-2 adds zero twice" still fails',
        'Go back with specpilot reopen TASK-101 red',
        '',
      ].join('\n'),
    );
    expect(result.status).toBe(1);
    expect(phaseOf()).toBe('verify');
    expect(hallucinations()[0].reasons).toEqual(['"AC-2 adds zero twice" still fails']);
  });

  test('a test suite that fails to run blocks verify', () => {
    setUp(`require('../src/missing');\n${COVERED_TEST}`);
    const result = runIn(project, 'verify', 'TASK-101');
    expect(result.stdout).toBe('');
    expect(result.status).toBe(1);
    expect(result.stderr.split('\n')[0]).toBe(
      'VERIFY: TASK-101 blocked, recorded as a hallucination in specs/TASK-101/hallucinations.json',
    );
    expect(phaseOf()).toBe('verify');
    const { reasons } = hallucinations()[0];
    expect(reasons.some((reason: string) => reason.startsWith("test/sum.test.js failed to run: Cannot find module '../src/missing'"))).toBe(true);
    expect(reasons).toEqual(expect.arrayContaining(['AC-1 has no test that covers it', 'AC-2 has no test that covers it']));
  });

  test.each(['green.json', 'mutation.json'])('a corrupt %s blocks verify through the mutation gate', (name) => {
    setUp(COVERED_TEST);
    fs.writeFileSync(file(`specs/TASK-101/${name}`), '{');
    const result = runIn(project, 'verify', 'TASK-101');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr.split('\n')[0]).toBe(
      'VERIFY: TASK-101 blocked, recorded as a hallucination in specs/TASK-101/hallucinations.json',
    );
    expect(phaseOf()).toBe('verify');
    expect(hallucinations()[0].reasons).toContain(`Corrupt ${name} in specs/TASK-101`);
  });

  test('tests changed after tdd green block verify through the mutation gate', () => {
    setUp(COVERED_TEST);
    fs.writeFileSync(file('test/sum.test.js'), `${COVERED_TEST}// changed\n`);
    const result = runIn(project, 'verify', 'TASK-101');
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe(
      [
        'VERIFY: TASK-101 blocked, recorded as a hallucination in specs/TASK-101/hallucinations.json',
        '  - Tests changed after tdd green (changed test/sum.test.js): go back with specpilot reopen TASK-101 red',
        'Go back with specpilot reopen TASK-101 red',
        '',
      ].join('\n'),
    );
    expect(result.status).toBe(1);
    expect(phaseOf()).toBe('verify');
  });

  // Root ignores file permissions, so a read-only folder cannot make the write fail there.
  const testUnlessRoot = process.getuid?.() === 0 ? test.skip : test;
  testUnlessRoot('a blocked verify that cannot write hallucinations.json exits 2 with one line and records nothing', () => {
    setUp(UNCOVERED_TEST);
    const taskDir = file('specs/TASK-101');
    // Everything verify reads is in place and hallucinations.json does not exist, so only the write fails.
    fs.chmodSync(taskDir, 0o555);
    let result: { status: number | null; stdout: string; stderr: string };
    try {
      result = runIn(project, 'verify', 'TASK-101');
    } finally {
      fs.chmodSync(taskDir, 0o755);
    }
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr.endsWith('\n')).toBe(true);
    const lines = result.stderr.trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('Cannot write specs/TASK-101/hallucinations.json: ')).toBe(true);
    expect(lines[0]).toMatch(/EACCES|EPERM|permission/i);
    expect(fs.existsSync(file(HALLUCINATIONS))).toBe(false);
    expect(phaseOf()).toBe('verify');
  });

  test('earlier hallucinations are kept: a blocked run appends, a passing run leaves the file as it was', () => {
    const earlier = { taskId: 'TASK-101', at: '2026-10-19T09:00:00.000Z', phase: 'verify', reasons: ['AC-1 has no test that covers it'] };
    setUp(UNCOVERED_TEST);
    fs.writeFileSync(file(HALLUCINATIONS), `${JSON.stringify([earlier], null, 2)}\n`);
    expect(runIn(project, 'verify', 'TASK-101').status).toBe(1);
    expect(hallucinations()).toEqual([
      earlier,
      { taskId: 'TASK-101', at: expect.any(String), phase: 'verify', reasons: ['AC-2 has no test that covers it'] },
    ]);

    setUp(COVERED_TEST);
    const before = fs.readFileSync(file(HALLUCINATIONS), 'utf8');
    expect(runIn(project, 'verify', 'TASK-101').status).toBe(0);
    expect(fs.readFileSync(file(HALLUCINATIONS), 'utf8')).toBe(before);
    expect(phaseOf()).toBe('done');
  }, 30_000);

  test('a passing verify adds verify → done to the history, and one test per AC is singular', () => {
    const oneEach = [
      "const { sum } = require('../src/sum');",
      "test('AC-1 adds two numbers', () => { expect(sum(1, 2)).toBe(3); });",
      "test('AC-2 adds zero', () => { expect(sum(5, 0)).toBe(5); });",
      '',
    ].join('\n');
    setUp(oneEach);
    const earlier = { from: 'mutation', to: 'verify', at: '2026-10-18T10:20:00.000Z' };
    fs.writeFileSync(
      file('specs/TASK-101/state.json'),
      JSON.stringify({ taskId: 'TASK-101', phase: 'verify', history: [earlier] }),
    );
    const result = runIn(project, 'verify', 'TASK-101');
    expect(result.stdout).toBe(
      ['  ✓ AC-1 (1 test)', '  ✓ AC-2 (1 test)', 'VERIFY: TASK-101 passed', 'TASK-101: verify → done', ''].join('\n'),
    );
    expect(result.status).toBe(0);
    const state = JSON.parse(fs.readFileSync(file('specs/TASK-101/state.json'), 'utf8'));
    expect(state).toEqual({
      taskId: 'TASK-101',
      phase: 'done',
      history: [earlier, { from: 'verify', to: 'done', at: expect.any(String) }],
    });
    expect(Number.isNaN(Date.parse(state.history[1].at))).toBe(false);
  });
});
