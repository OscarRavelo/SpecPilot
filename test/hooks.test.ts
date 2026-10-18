import fs from 'fs';
import os from 'os';
import path from 'path';
import { bashTargets, classifyPath, checkToolUse, stopWarning } from '../src/hooks';
import type { ToolUse } from '../src/hooks';
import { PHASES } from '../src/state';

describe('classifyPath', () => {
  test.each([
    ['specs/TASK-101/state.json', 'state'],
    ['specs/TASK-101/audit.md', 'audit'],
    ['specs/TASK-101/red.json', 'state'],
    ['specs/TASK-101/green.json', 'state'],
    ['src/users.test.ts', 'test'],
    ['src/Button.spec.tsx', 'test'],
    ['src/__tests__/users.ts', 'test'],
    ['test/cli.test.ts', 'test'],
    ['tests/helpers.js', 'test'],
    ['test/fixtures/user.json', 'test'],
    ['src/users.ts', 'source'],
    ['src/components/Button.tsx', 'source'],
    ['server.js', 'source'],
    ['lib/index.mjs', 'source'],
    ['lib/index.cjs', 'source'],
    ['src/App.jsx', 'source'],
    ['README.md', 'other'],
    ['package.json', 'other'],
    ['specs/TASK-101/spec.md', 'other'],
    ['specs/TASK-101/grill.md', 'other'],
    ['src/styles.css', 'other'],
  ])('%s is %s', (file, kind) => {
    expect(classifyPath(file)).toBe(kind);
  });

  test('state.json and audit.md only count inside a task folder', () => {
    expect(classifyPath('state.json')).toBe('other');
    expect(classifyPath('docs/audit.md')).toBe('other');
  });
});

describe('bashTargets', () => {
  test.each<[string, string[]]>([
    ['echo x > src/a.ts', ['src/a.ts']],
    ['echo x >> src/a.ts', ['src/a.ts']],
    ['echo x >src/a.ts', ['src/a.ts']],
    ['npm test 2> err.log', ['err.log']],
    ['npm test &> all.log', ['all.log']],
    ['npm test 2>&1 | tee out.log', ['out.log']],
    ['npm test > /dev/null 2>&1', ['/dev/null']],
    ['echo hi >&2', []],
    ['touch src/a.ts >&2', ['src/a.ts']],
    ['touch src/a.ts 2> err.log', ['err.log', 'src/a.ts']],
    ['wc -l < src/a.ts', []],
    ['cat src/a.ts', []],
    ['grep -n "a > b" src/a.ts', []],
    ["grep -n 'a >> b' src/a.ts", []],
    ['echo "x > y" > out.txt', ['out.txt']],
    ['echo a\\>b', []],
    ["sed -i '' 's/a/b/' src/a.ts", ['src/a.ts']],
    ["sed -i 's/a/b/' src/a.ts src/b.ts", ['src/a.ts', 'src/b.ts']],
    ["sed -i.bak -e 's/a/b/' src/a.ts", ['src/a.ts']],
    ["sed --in-place -e 's/a/b/' -e 's/c/d/' src/a.ts", ['src/a.ts']],
    ["sed -n '1,20p' src/a.ts", []],
    ["perl -pi -e 's/a/b/' src/a.ts", ['src/a.ts']],
    ["perl -ne 'print' src/a.ts", []],
    ['tee -a src/a.ts', ['src/a.ts']],
    ['cp a.ts src/b.ts', ['src/b.ts']],
    ['cp -r a.ts b.ts src/', ['src/a.ts', 'src/b.ts']],
    ['mv src/a.ts src/b.ts', ['src/a.ts', 'src/b.ts']],
    ['rm -f src/a.ts', ['src/a.ts']],
    ['touch src/a.ts', ['src/a.ts']],
    ['truncate -s 0 src/a.ts', ['src/a.ts']],
    ['dd if=/dev/zero of=src/a.ts bs=1 count=1', ['src/a.ts']],
    ['FOO=1 /bin/rm src/a.ts', ['src/a.ts']],
    ['npm run build && echo x > src/a.ts; rm test/a.test.ts', ['src/a.ts', 'test/a.test.ts']],
    ['git status || touch src/a.ts', ['src/a.ts']],
    ["cat > src/a.ts <<'EOF'\nconst big = 1 > 0;\nrm src/b.ts\nEOF\ntouch src/c.ts", ['src/a.ts', 'src/c.ts']],
    ['npx specpilot gate TASK-101', []],
    ['npm test', []],
    ['echo "unterminated > src/a.ts', []],
  ])('%j writes %j', (command, targets) => {
    expect(bashTargets(command)).toEqual(targets);
  });

  test('cp into an existing folder writes the file inside it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-bash-'));
    try {
      fs.mkdirSync(path.join(root, 'src'));
      expect(bashTargets('cp lib/a.ts src', root)).toEqual(['src/a.ts']);
      expect(bashTargets('cp lib/a.ts other', root)).toEqual(['other']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('checkToolUse', () => {
  let root: string;

  const writeTask = (taskId: string, phase: string) => {
    fs.mkdirSync(path.join(root, 'specs', taskId), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'specs', taskId, 'state.json'),
      JSON.stringify({ taskId, phase, history: [] }),
    );
  };
  const edit = (file: string, tool = 'Edit', extra: Partial<ToolUse> = {}): ToolUse => ({
    tool_name: tool,
    tool_input: tool === 'NotebookEdit' ? { notebook_path: path.join(root, file) } : { file_path: path.join(root, file) },
    ...extra,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-hooks-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // Which kinds of file each phase lets the agent edit.
  const ALLOWED: Record<string, string[]> = {
    research: [],
    grill: [],
    plan: [],
    red: ['test'],
    green: ['source'],
    mutation: ['source'],
    verify: [],
    done: ['test', 'source'],
  };

  test('the table covers every phase', () => {
    expect(Object.keys(ALLOWED)).toEqual([...PHASES]);
  });

  describe.each(PHASES.map((phase) => [phase]))('in %s', (phase) => {
    beforeEach(() => writeTask('TASK-101', phase));

    test.each([
      ['test', 'src/users.test.ts'],
      ['source', 'src/users.ts'],
    ])('a %s edit follows the phase table', (kind, file) => {
      const decision = checkToolUse(edit(file), root);
      expect(decision.allow).toBe(ALLOWED[phase].includes(kind));
      if (!decision.allow) {
        expect(decision.reason).toContain(`TASK-101 is in ${phase}`);
        expect(decision.reason).toContain(file);
      }
    });

    test('other files can always be edited', () => {
      expect(checkToolUse(edit('README.md'), root).allow).toBe(true);
    });
  });

  test('editing code before red is blocked and the reason says when it opens', () => {
    writeTask('TASK-101', 'plan');
    const decision = checkToolUse(edit('src/users.ts'), root);
    expect(decision).toEqual({ allow: false, reason: expect.stringContaining('green or mutation') });
  });

  test('editing tests after green is blocked and the reason points to reopen', () => {
    writeTask('TASK-101', 'mutation');
    const decision = checkToolUse(edit('src/users.test.ts'), root);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('only in red');
    expect(decision.reason).toContain('specpilot reopen TASK-101 red');
  });

  test.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s is checked', (tool) => {
    writeTask('TASK-101', 'plan');
    expect(checkToolUse(edit('src/users.ts', tool), root).allow).toBe(false);
  });

  describe('Bash', () => {
    const bash = (command: string): ToolUse => ({ tool_name: 'Bash', tool_input: { command } });

    test('writing code from the shell before red is blocked like an Edit', () => {
      writeTask('TASK-101', 'plan');
      const decision = checkToolUse(bash('echo x > src/a.ts'), root);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain('TASK-101 is in plan, so src/a.ts cannot be edited');
    });

    test('editing a test from the shell in green is blocked', () => {
      writeTask('TASK-101', 'green');
      expect(checkToolUse(bash("sed -i '' 's/a/b/' test/a.test.ts"), root).allow).toBe(false);
      expect(checkToolUse(bash('echo x > src/a.ts'), root)).toEqual({ allow: true });
    });

    test('state.json cannot be written from the shell', () => {
      const decision = checkToolUse(bash('echo {} > specs/TASK-101/state.json'), root);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain('specpilot gate');
    });

    test('the first blocked file is reported, after allowed ones', () => {
      writeTask('TASK-101', 'red');
      const decision = checkToolUse(bash('echo x > test/a.test.ts && echo y > src/a.ts'), root);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain('src/a.ts cannot be edited');
    });

    test('copying into a source folder is blocked', () => {
      writeTask('TASK-101', 'plan');
      fs.mkdirSync(path.join(root, 'src'));
      expect(checkToolUse(bash('cp /tmp/a.ts src'), root).allow).toBe(false);
    });

    test.each(['npm test', 'cat src/a.ts', 'npm test > /dev/null 2>&1', 'echo note > NOTES.md'])(
      '%s is allowed in plan',
      (command) => {
        writeTask('TASK-101', 'plan');
        expect(checkToolUse(bash(command), root)).toEqual({ allow: true });
      },
    );

    test('a Bash call without a command is allowed', () => {
      writeTask('TASK-101', 'plan');
      expect(checkToolUse({ tool_name: 'Bash', tool_input: {} }, root)).toEqual({ allow: true });
    });
  });

  test('tools that do not edit files are allowed', () => {
    writeTask('TASK-101', 'plan');
    const read: ToolUse = { tool_name: 'Read', tool_input: { file_path: path.join(root, 'src/users.ts') } };
    expect(checkToolUse(read, root)).toEqual({ allow: true });
  });

  test('relative paths are resolved against the project root', () => {
    writeTask('TASK-101', 'plan');
    const relative: ToolUse = { tool_name: 'Write', tool_input: { file_path: 'src/users.ts' } };
    expect(checkToolUse(relative, root).allow).toBe(false);
  });

  test('a path through a symlink to the project is still inside it', () => {
    writeTask('TASK-101', 'plan');
    const link = `${root}-link`;
    fs.symlinkSync(root, link);
    try {
      const viaLink: ToolUse = { tool_name: 'Write', tool_input: { file_path: path.join(link, 'src', 'new.ts') } };
      expect(checkToolUse(viaLink, root).allow).toBe(false);
      expect(checkToolUse(edit('src/new.ts'), link).allow).toBe(false);
    } finally {
      fs.unlinkSync(link);
    }
  });

  test('files outside the project are allowed', () => {
    writeTask('TASK-101', 'plan');
    const outside = path.join(os.tmpdir(), 'elsewhere', 'users.ts');
    expect(checkToolUse({ tool_name: 'Write', tool_input: { file_path: outside } }, root).allow).toBe(true);
  });

  test('without tasks every file but state.json can be edited', () => {
    expect(checkToolUse(edit('src/users.ts'), root).allow).toBe(true);
    expect(checkToolUse(edit('src/users.test.ts'), root).allow).toBe(true);
    expect(checkToolUse(edit('specs/TASK-101/state.json', 'Write'), root).allow).toBe(false);
  });

  test('a task without state.json is in research', () => {
    fs.mkdirSync(path.join(root, 'specs', 'TASK-101'), { recursive: true });
    const decision = checkToolUse(edit('src/users.ts'), root);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('TASK-101 is in research');
  });

  test('state.json can never be edited, even in done', () => {
    writeTask('TASK-101', 'done');
    const decision = checkToolUse(edit('specs/TASK-101/state.json', 'Write'), root);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('specpilot gate');
  });

  test('audit.md can only be written by the grill-auditor subagent', () => {
    writeTask('TASK-101', 'grill');
    const file = 'specs/TASK-101/audit.md';

    const main = checkToolUse(edit(file, 'Write'), root);
    expect(main.allow).toBe(false);
    expect(main.reason).toContain('grill-auditor');

    expect(checkToolUse(edit(file, 'Write', { agent_type: 'other-agent' }), root).allow).toBe(false);
    expect(checkToolUse(edit(file, 'Write', { agent_type: 'grill-auditor' }), root)).toEqual({ allow: true });
  });

  describe('with several active tasks', () => {
    beforeEach(() => {
      writeTask('TASK-101', 'red');
      writeTask('TASK-102', 'green');
      writeTask('TASK-103', 'done');
    });

    test('an edit must be allowed by every active task, and the reason suggests SPECPILOT_TASK', () => {
      const decision = checkToolUse(edit('src/users.ts'), root);
      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain('TASK-101 is in red');
      expect(decision.reason).toContain('SPECPILOT_TASK');
      expect(checkToolUse(edit('src/users.test.ts'), root).allow).toBe(false);
    });

    test('a task chosen by id is the only one that counts', () => {
      expect(checkToolUse(edit('src/users.ts'), root, 'TASK-102').allow).toBe(true);
      expect(checkToolUse(edit('src/users.test.ts'), root, 'TASK-101').allow).toBe(true);
      expect(checkToolUse(edit('src/users.test.ts'), root, 'TASK-102').allow).toBe(false);
    });

    test('a done task chosen by id blocks nothing', () => {
      expect(checkToolUse(edit('src/users.ts'), root, 'TASK-103').allow).toBe(true);
    });

    test('a chosen task that does not exist blocks code and tests', () => {
      const decision = checkToolUse(edit('src/users.ts'), root, 'TASK-404');
      expect(decision.allow).toBe(false);
      expect(decision.reason).toContain('SPECPILOT_TASK=TASK-404');
    });
  });

  test('a single active task does not mention SPECPILOT_TASK', () => {
    writeTask('TASK-101', 'plan');
    writeTask('TASK-102', 'done');
    const decision = checkToolUse(edit('src/users.ts'), root);
    expect(decision.allow).toBe(false);
    expect(decision.reason).not.toContain('SPECPILOT_TASK');
  });

  test('a corrupt state.json blocks code and tests instead of letting them through', () => {
    writeTask('TASK-101', 'green');
    fs.writeFileSync(path.join(root, 'specs', 'TASK-101', 'state.json'), '{nope');
    const decision = checkToolUse(edit('src/users.ts'), root);
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('Corrupt state.json');
    expect(checkToolUse(edit('README.md'), root).allow).toBe(true);
  });
});

describe('stopWarning', () => {
  let root: string;
  const writeTask = (taskId: string, phase: string) => {
    fs.mkdirSync(path.join(root, 'specs', taskId), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'specs', taskId, 'state.json'),
      JSON.stringify({ taskId, phase, history: [] }),
    );
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-stop-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('without tasks there is nothing to say', () => {
    expect(stopWarning(root)).toBeNull();
  });

  test.each(['research', 'grill', 'plan', 'red', 'green', 'done'])('a task in %s gets no warning', (phase) => {
    writeTask('TASK-101', phase);
    expect(stopWarning(root)).toBeNull();
  });

  test.each(['mutation', 'verify'])('a task in %s is reported as not done', (phase) => {
    writeTask('TASK-101', phase);
    expect(stopWarning(root)).toBe(
      `TASK-101 is in ${phase}: the mutation phase cannot be completed yet (specpilot mutate is not implemented), so the task is not done.`,
    );
  });

  test('every waiting task is listed', () => {
    writeTask('TASK-101', 'mutation');
    writeTask('TASK-102', 'green');
    writeTask('TASK-103', 'verify');
    const warning = stopWarning(root) as string;
    expect(warning).toContain('TASK-101 is in mutation');
    expect(warning).toContain('TASK-103 is in verify');
    expect(warning).not.toContain('TASK-102');
  });

  test('SPECPILOT_TASK chooses the task', () => {
    writeTask('TASK-101', 'mutation');
    writeTask('TASK-102', 'green');
    expect(stopWarning(root, 'TASK-102')).toBeNull();
    expect(stopWarning(root, 'TASK-101')).toContain('TASK-101 is in mutation');
  });

  test('state that cannot be read is reported, not hidden', () => {
    writeTask('TASK-101', 'mutation');
    fs.writeFileSync(path.join(root, 'specs', 'TASK-101', 'state.json'), '{nope');
    expect(stopWarning(root)).toContain('Corrupt state.json');
    expect(stopWarning(root, 'TASK-404')).toContain('SPECPILOT_TASK=TASK-404');
  });
});
