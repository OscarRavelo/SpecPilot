import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const CLAUDE = path.join(__dirname, '..', 'templates', '.claude');
const SKILL = path.join(CLAUDE, 'skills', 'sp-grill', 'SKILL.md');
const AUDITOR = path.join(CLAUDE, 'agents', 'grill-auditor.md');
const SETTINGS = path.join(CLAUDE, 'settings.json');
const HELP = spawnSync(process.execPath, [path.join(__dirname, '..', 'dist', 'cli.js'), '--help'], {
  encoding: 'utf8',
}).stdout;

function frontmatter(text: string): Record<string, string> {
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return {};
  return Object.fromEntries(
    match[1].split('\n').map((line) => {
      const [key, ...value] = line.split(':');
      return [key.trim(), value.join(':').trim()];
    }),
  );
}

// Commands listed by --help, e.g. "gate", "ledger check", "tdd red|green", "hook pre-tool-use".
const KNOWN = new Set([...HELP.matchAll(/^  ([a-z]+(?: [a-z|-]+)?)/gm)].map((m) => m[1]));

// The prompts must not tell the agent to run commands that do not exist.
function specpilotCommands(text: string): string[] {
  return [...text.matchAll(/specpilot ([a-z]+(?: [a-z-]+)?)/g)].map((m) => m[1]);
}

function isKnown(mention: string): boolean {
  const [first, second] = mention.split(' ');
  return (second !== undefined && KNOWN.has(`${first} ${second}`)) || KNOWN.has(first);
}

describe.each([
  ['sp-grill skill', SKILL, 'sp-grill'],
  ['grill-auditor agent', AUDITOR, 'grill-auditor'],
])('%s', (_, file, name) => {
  const text = fs.readFileSync(file, 'utf8');

  test('has a name and a description', () => {
    expect(frontmatter(text).name).toBe(name);
    expect(frontmatter(text).description.length).toBeGreaterThan(40);
  });

  test('only mentions specpilot commands that exist', () => {
    const commands = specpilotCommands(text);
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect({ command, known: isKnown(command) }).toEqual({ command, known: true });
    }
  });
});

test('the known command list is read from --help', () => {
  expect(KNOWN).toEqual(expect.objectContaining({ size: expect.any(Number) }));
  expect([...KNOWN]).toEqual(expect.arrayContaining(['gate', 'spec lint', 'ledger check', 'hook pre-tool-use']));
  expect(KNOWN.has('ledger')).toBe(false);
});

describe('sp-grill skill', () => {
  const text = fs.readFileSync(SKILL, 'utf8');

  test.each([
    'npx specpilot grill checklist',
    'npx specpilot ledger check',
    'npx specpilot gate',
    'grill-auditor',
    'one question at a time',
  ])('mentions %s', (phrase) => {
    expect(text).toContain(phrase);
  });
});

describe('grill-auditor agent', () => {
  const text = fs.readFileSync(AUDITOR, 'utf8');
  const tools = (frontmatter(text).tools || '').split(',').map((tool) => tool.trim());

  test('cannot edit code', () => {
    expect(tools).toEqual(expect.arrayContaining(['Read', 'Grep', 'Glob']));
    for (const tool of ['Edit', 'MultiEdit', 'NotebookEdit']) expect(tools).not.toContain(tool);
  });

  test.each(['npx specpilot grill hash', 'Ledger hash:', '## Blockers', '- none'])('explains %s', (phrase) => {
    expect(text).toContain(phrase);
  });
});

describe('settings.json', () => {
  const settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  const groups: { matcher: string; hooks: { type: string; command: string }[] }[] = settings.hooks?.PreToolUse ?? [];
  const phaseGroups = groups.filter((g) =>
    (g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('npx --no specpilot hook pre-tool-use')),
  );

  test('AC-9: runs the phase hook through npx --no before every tool that edits files, including Bash', () => {
    expect(phaseGroups).toHaveLength(1);
    const group = phaseGroups[0];
    expect(group.matcher.split('|').sort()).toEqual(['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
    expect(group.hooks).toEqual([{ type: 'command', command: expect.any(String) }]);
    // Roles stay off by default.
    expect(group.hooks[0].command).not.toContain('--roles');
  });

  test('AC-9: warns when the agent stops, through npx --no', () => {
    const stop: { matcher?: string; hooks: { type: string; command: string }[] }[] = settings.hooks?.Stop;
    expect(stop).toEqual([{ hooks: [{ type: 'command', command: 'npx --no specpilot hook stop' }] }]);
  });

  test('only runs specpilot commands that exist', () => {
    const all: { hooks: { command: string }[] }[] = Object.values(settings.hooks).flat() as never;
    const commands = all.flatMap((g) => g.hooks.flatMap((h) => specpilotCommands(h.command)));
    expect(commands.sort()).toEqual(['hook pre-tool-use', 'hook stop']);
    for (const command of commands) expect(isKnown(command)).toBe(true);
  });
});

// The installed PreToolUse hook must fail closed: if specpilot is missing or crashes, every edit is blocked.
describe('the template PreToolUse hook command', () => {
  // A missing or changed template must fail on an assertion, not crash the suite.
  const settings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {};
  const groups: { hooks?: { command?: string }[] }[] = settings.hooks?.PreToolUse ?? [];
  const command: string | undefined = groups
    .flatMap((g) => g.hooks ?? [])
    .map((h) => h.command)
    .find((c) => typeof c === 'string' && c.includes('npx --no specpilot hook pre-tool-use'));
  const INPUT = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/x.ts' } });
  let dir: string;

  // npm test sets npm_* variables that would point npx at this repo instead of the temp project.
  const runHook = () => {
    expect(typeof command).toBe('string');
    const env: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (/^npm_/i.test(key) || key === 'SPECPILOT_TASK') continue;
      env[key] = value;
    }
    return spawnSync('sh', ['-c', command as string], {
      input: INPUT,
      encoding: 'utf8',
      cwd: dir,
      env: { ...env, CLAUDE_PROJECT_DIR: dir },
    });
  };
  const fakeSpecpilot = (script: string) => {
    const bin = path.join(dir, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'specpilot'), `#!/bin/sh\ncat > /dev/null\n${script}\n`);
    fs.chmodSync(path.join(bin, 'specpilot'), 0o755);
  };
  const expectBlocked = (result: ReturnType<typeof runHook>) => {
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Blocked by SpecPilot');
    expect(result.stderr).toContain('STOP');
    expect(result.stderr).toContain('one question at a time');
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-template-hook-'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0' }));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('AC-9: exits 0 when specpilot exits 0', () => {
    fakeSpecpilot('exit 0');
    const result = runHook();
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
  }, 30000);

  test("AC-9: passes specpilot's own denial (exit 2 and its reason) through", () => {
    fakeSpecpilot("echo 'denied: specs/TASK-1 is in red' >&2\nexit 2");
    const result = runHook();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('denied: specs/TASK-1 is in red');
    expect(result.stderr).not.toContain('STOP');
  }, 30000);

  test('AC-9: blocks with exit 2 and tells the agent to stop and ask when specpilot exits 1', () => {
    fakeSpecpilot("echo 'boom' >&2\nexit 1");
    expectBlocked(runHook());
  }, 30000);

  test('AC-9: blocks with exit 2 and tells the agent to stop and ask when the project has no specpilot', () => {
    expect(fs.existsSync(path.join(dir, 'node_modules'))).toBe(false);
    expectBlocked(runHook());
  }, 30000);
});
