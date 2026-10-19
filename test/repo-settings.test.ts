import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

// This repo's own .claude/settings.json: SpecPilot is built with its own hook, run fail-closed.
const REPO = path.join(__dirname, '..');
const SETTINGS = path.join(REPO, '.claude', 'settings.json');

type Hook = { type: string; command: string };
type Group = { matcher: string; hooks: Hook[] };

// A missing file must fail on an assertion, not crash the suite.
const settings = fs.existsSync(SETTINGS) ? JSON.parse(fs.readFileSync(SETTINGS, 'utf8')) : {};
const groups: Group[] = settings.hooks?.PreToolUse ?? [];
const roleGroups = groups.filter((group) =>
  (group.hooks ?? []).some((hook) => typeof hook.command === 'string' && hook.command.includes('hook pre-tool-use --roles')),
);
const command: string | undefined = roleGroups[0]?.hooks?.[0]?.command;

describe('repo .claude/settings.json', () => {
  test('runs the role hook before every tool that edits files, including Bash', () => {
    expect(roleGroups).toHaveLength(1);
    const group = roleGroups[0];
    expect(group.matcher.split('|').sort()).toEqual(['Bash', 'Edit', 'MultiEdit', 'NotebookEdit', 'Write']);
    expect(group.hooks).toEqual([{ type: 'command', command: expect.any(String) }]);
    expect(group.hooks[0].command).toContain('"$CLAUDE_PROJECT_DIR/dist/cli.js" hook pre-tool-use --roles');
  });
});

describe('repo package.json', () => {
  test('requires Node >= 22, as Stryker does', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
    expect(pkg.engines?.node).toBe('>=22');
  });
});

describe('the repo PreToolUse hook command', () => {
  let dir: string;
  const INPUT = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: '/tmp/x.ts' } });

  const runHook = (projectDir: string, input = INPUT) => {
    expect(typeof command).toBe('string');
    const { SPECPILOT_TASK, ...rest } = process.env;
    return spawnSync('sh', ['-c', command as string], {
      input,
      encoding: 'utf8',
      env: { ...rest, CLAUDE_PROJECT_DIR: projectDir },
    });
  };
  const fakeCli = (source: string) => {
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'dist', 'cli.js'), source);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-repo-hook-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('a missing dist/ blocks the edit and tells the agent to stop and ask', () => {
    const result = runHook(dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Blocked by SpecPilot: the SpecPilot hook failed (exit 1), so no edit is safe.');
    expect(result.stderr).toContain('Cannot find module');
    expect(result.stderr).toContain('STOP: do not try to fix or work around the hook yourself.');
    expect(result.stderr).toContain('Ask the human how to fix it, one question at a time');
  });

  test('a hook that crashes blocks the edit and shows the error', () => {
    fakeCli("throw new Error('boom');\n");
    const result = runHook(dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('the SpecPilot hook failed (exit 1)');
    expect(result.stderr).toContain('boom');
    expect(result.stderr).toContain('STOP:');
  });

  test("a hook's own denial is passed through unchanged", () => {
    fakeCli("process.stderr.write('denied: x\\n');\nprocess.exit(2);\n");
    const result = runHook(dir);
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe('denied: x');
  });

  test('an allowed edit exits 0 with no output', () => {
    fakeCli('process.exit(0);\n');
    const result = runHook(dir);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });

  test('the hook gets --roles and the tool call on stdin', () => {
    fakeCli(
      "process.stderr.write(process.argv.slice(2).join(' ') + '\\n' + require('fs').readFileSync(0, 'utf8'));\nprocess.exit(2);\n",
    );
    const result = runHook(dir);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('hook pre-tool-use --roles');
    expect(result.stderr).toContain(INPUT);
  });

  describe('against the real build', () => {
    const write = (file: string, agentType?: string) =>
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Write',
        tool_input: { file_path: path.join(REPO, file) },
        ...(agentType === undefined ? {} : { agent_type: agentType }),
      });

    test('the main session cannot write source code', () => {
      const result = runHook(REPO, write('src/x.ts'));
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('only code-agent may edit source code (src/x.ts)');
    });

    test('code-agent can write source code', () => {
      const result = runHook(REPO, write('src/x.ts', 'code-agent'));
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });

    test('the main session can write the README', () => {
      const result = runHook(REPO, write('README.md'));
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
    });
  });
});
