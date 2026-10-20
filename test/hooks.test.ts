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
    ['specs/TASK-1/mutation.json', 'state'],
    ['specs/TASK-1/equivalents.md', 'state'],
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

  test('equivalents.md is never edited by an agent: only the human approves equivalent mutants', () => {
    writeTask('TASK-101', 'mutation');
    for (const agent of [undefined, 'code-agent', 'tests-agent']) {
      expect(checkToolUse(edit('specs/TASK-101/equivalents.md', 'Write', { agent_type: agent }), root)).toEqual({
        allow: false,
        reason: 'Blocked by SpecPilot: specs/TASK-101/equivalents.md is written by specpilot mutate, and only the human approves equivalent mutants in it.',
      });
    }
  });

  test('mutation.json is written only by the CLI, and the reason names specpilot mutate', () => {
    writeTask('TASK-101', 'mutation');
    expect(checkToolUse(edit('specs/TASK-101/mutation.json', 'Write'), root)).toEqual({
      allow: false,
      reason:
        'Blocked by SpecPilot: specs/TASK-101/mutation.json is written only by the specpilot CLI (specpilot tdd, specpilot mutate, specpilot gate, specpilot reopen).',
    });
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

describe('checkToolUse with agent roles', () => {
  let root: string;

  const writeTask = (taskId: string, phase: string) => {
    fs.mkdirSync(path.join(root, 'specs', taskId), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'specs', taskId, 'state.json'),
      JSON.stringify({ taskId, phase, history: [] }),
    );
  };
  const edit = (file: string, tool: string, agentType?: string): ToolUse => ({
    tool_name: tool,
    tool_input: tool === 'NotebookEdit' ? { notebook_path: path.join(root, file) } : { file_path: path.join(root, file) },
    ...(agentType === undefined ? {} : { agent_type: agentType }),
  });
  const bash = (command: string, agentType?: string): ToolUse => ({
    tool_name: 'Bash',
    tool_input: { command },
    ...(agentType === undefined ? {} : { agent_type: agentType }),
  });
  const withRoles = (input: ToolUse, taskId?: string) => checkToolUse(input, root, taskId, true);

  const ALLOWED = { allow: true };
  const ONLY_TESTS_AGENT = (file: string) => ({
    allow: false,
    reason: `Blocked by SpecPilot: only tests-agent may edit tests (${file}).`,
  });
  const ONLY_CODE_AGENT = (file: string) => ({
    allow: false,
    reason: `Blocked by SpecPilot: only code-agent may edit source code (${file}).`,
  });
  const TESTS_AGENT_OTHER = (file: string) => ({
    allow: false,
    reason: `Blocked by SpecPilot: tests-agent may only edit tests, and ${file} is not a test.`,
  });
  const CODE_AGENT_OTHER = (file: string) => ({
    allow: false,
    reason: `Blocked by SpecPilot: code-agent may only edit source code, and ${file} is not source code.`,
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-roles-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  // What each agent may do with a test, a source file and any other file, without tasks in specs/.
  const MATRIX: [string, string | undefined, Record<string, object>][] = [
    [
      'the main session',
      undefined,
      {
        'test/a.test.ts': ONLY_TESTS_AGENT('test/a.test.ts'),
        'src/a.ts': ONLY_CODE_AGENT('src/a.ts'),
        'README.md': ALLOWED,
      },
    ],
    [
      'tests-agent',
      'tests-agent',
      {
        'test/a.test.ts': ALLOWED,
        'src/a.ts': ONLY_CODE_AGENT('src/a.ts'),
        'README.md': TESTS_AGENT_OTHER('README.md'),
      },
    ],
    [
      'code-agent',
      'code-agent',
      {
        'test/a.test.ts': ONLY_TESTS_AGENT('test/a.test.ts'),
        'src/a.ts': ALLOWED,
        'README.md': CODE_AGENT_OTHER('README.md'),
      },
    ],
    [
      'grill-auditor',
      'grill-auditor',
      {
        'test/a.test.ts': ONLY_TESTS_AGENT('test/a.test.ts'),
        'src/a.ts': ONLY_CODE_AGENT('src/a.ts'),
        'README.md': ALLOWED,
      },
    ],
  ];

  describe.each(MATRIX)('%s', (_, agentType, expected) => {
    test.each(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])('%s follows the role table', (tool) => {
      const decisions = Object.fromEntries(
        Object.keys(expected).map((file) => [file, withRoles(edit(file, tool, agentType))]),
      );
      expect(decisions).toEqual(expected);
    });
  });

  describe('Bash', () => {
    test('the main session cannot write source code from the shell', () => {
      expect(withRoles(bash('echo x > src/a.ts'))).toEqual(ONLY_CODE_AGENT('src/a.ts'));
    });

    // tests-agent and code-agent write files only with Edit/Write: in Bash, every simple command must be
    // on the allowlist with known read-only options, and redirections may only go to /dev/null or a descriptor.
    const WRITING_AGENTS = ['tests-agent', 'code-agent'];

    const expectBashWriteDenied = (command: string, agentType: string) => {
      const decision = withRoles(bash(command, agentType));
      expect({ command, allow: decision.allow }).toEqual({ command, allow: false });
      expect(decision.reason).toContain(`Blocked by SpecPilot: ${agentType} may not run this command from Bash (`);
      expect(decision.reason).toContain(
        '). Only allowlisted read-only commands may run; write files with Edit or Write. Allowed in Bash: ',
      );
      expect(decision.reason).not.toContain('may not write files');
    };

    describe.each(WRITING_AGENTS.map((agent) => [agent]))('%s', (agentType) => {
      test.each([
        // Writes, including inside the agent's own area.
        ["sed -i 's/a/b/' src/x.ts"],
        ["sed -i '' 's/a/b/' src/a.ts"],
        ["sed -n '1,5p' src/a.ts"],
        ["awk '{ print }' src/a.ts"],
        ['echo x > test/a.test.ts'],
        ['echo x > src/a.ts'],
        ['echo x > out.txt'],
        ['echo x >> out.txt'],
        ['npm test 2> err.log'],
        ['npm test &> all.log'],
        ['npm test 2>&1 | tee out.log'],
        ['tee src/a.ts'],
        ['cp a.ts src/b.ts'],
        ['mv src/a.ts src/b.ts'],
        ['rm test/a.test.ts'],
        ['rm -f out.txt'],
        ['touch src/a.ts'],
        ['mkdir test/fixtures/new'],
        ['chmod +x dist/cli.js'],
        // Programs that can write anything.
        [`node -e "require('fs').writeFileSync('src/a.ts', '')"`],
        ['node -e "x"'],
        [`python -c "open('test/a.test.ts', 'w')"`],
        [`python3 -c "print(1)"`],
        ["perl -i -pe 's/a/b/' src/a.ts"],
        ["perl -ne 'print' src/a.ts"],
        // Shell constructs the hook cannot see through.
        ["cat > src/a.ts <<'EOF'\nconst a = 1;\nEOF"],
        ["cat <<'EOF'\nhello\nEOF"],
        ['echo $(rm src/a.ts)'],
        ['echo `rm src/a.ts`'],
        ['diff <(ls src) <(ls test)'],
        ['eval "rm src/a.ts"'],
        ['exec rm src/a.ts'],
        ['source script.sh'],
        ['frobnicate src/a.ts'],
        ['npm test && frobnicate'],
        ['echo "unterminated > src/a.ts'],
        // Options that write or execute on allowed programs.
        ['git diff --output=x'],
        ['git log -o x'],
        ['git diff --ext-diff'],
        ['git diff --textconv'],
        ['git -c core.pager=x log'],
        ['git -C sub status'],
        ['npx jest --outputFile=x'],
        ['npm test -- --outputFile=x'],
        ['npm test -- --coverage'],
        ['npx jest -u'],
        ['npx jest --updateSnapshot'],
        ['npx jest --coverage'],
        ['npx jest --config x'],
        ['npx jest --watch'],
        ['rg --pre x pat'],
        ['npx tsc'],
        ['npx tsc -p tsconfig.json'],
        ['npx tsc --noEmit --outDir x'],
        ['npx tsc --build'],
        ['find . -delete'],
        ['find . -exec rm {} \\;'],
        ['find . -name "*.ts" -fprint out.txt'],
        ['npx --yes jest'],
        ['npx -p cowsay cowsay hi'],
        ['grep --unknown-flag x'],
        ['grep -rnZ x src'],
        ['tail -f out.log'],
        ['npm install'],
        ['npm run lint'],
        // ">&" followed by a word that is not a number or "-" writes a file.
        ['echo hi >&out.txt'],
        // The tokenizer must not lose track of quotes; an unterminated quote fails closed.
        ['echo "\\" " > out.txt " "'],
        ['echo "\\" ; echo "'],
        // $'...' and $"..." are expanded by the shell.
        ["git diff $'\\x2d\\x2doutput=out.txt'"],
        ['echo $"x"'],
        // An option value given as the next word may not be another option.
        ['git diff -U --output=out.txt'],
        ['git log -U --output=out.txt'],
        ['git diff -U 5'],
        ['git log --pretty --output=out.txt'],
        ['git log --pretty oneline'],
        ['git log --format --output=out.txt'],
        ['npx tsc --noEmit --pretty --generateTrace d'],
        ['npx jest -t --outputFile=r.json --json'],
        ['npm test -- --testNamePattern --outputFile=r.json --json'],
        // --noEmit takes no value.
        ['npx tsc --noEmit false -p tsconfig.json'],
        // Every VAR=value prefix is blocked.
        ['NODE_OPTIONS=--require=./x.js npm test'],
        ['GIT_EXTERNAL_DIFF=x git diff'],
        ['RIPGREP_CONFIG_PATH=x rg y'],
        ['CI=1 npm test'],
        ['FOO=1 npm test'],
        // cd is always blocked.
        ['cd sub && npm test'],
        ['cd .'],
        ['cd test/fixtures/p && npx jest'],
        // Every separator still checks every command.
        ['npm test || rm x'],
        ['npm test & rm x'],
        ['npm test |& rm x'],
        ['npm test\nrm x'],
        // specpilot commands that neither agent may run.
        ['npx specpilot gate T'],
        ['npx specpilot reopen T red'],
        ['npx specpilot spec lint x'],
        ['npx specpilot hook pre-tool-use'],
        ['node dist/cli.js gate T'],
        ['node dist/cli.js reopen T red'],
        ['node dist/cli.js spec lint x'],
        ['node dist/cli.js hook pre-tool-use'],
      ])('%j is blocked', (command) => {
        expectBashWriteDenied(command, agentType);
      });

      test.each([
        ['npm test'],
        ['npm run typecheck'],
        ['npm run build'],
        ['npx jest x'],
        ['npx jest -t "AC-1" test/x.test.ts'],
        ["npx jest -t 'AC-1' test/x.test.ts"],
        ['npm test -- -t "AC-1"'],
        ['npx tsc --noEmit -p tsconfig.json'],
        ['cat src/a.ts | grep x'],
        ['ls test | wc -l'],
        ['ls -la src'],
        ['git diff --stat'],
        ['git diff | head -20'],
        ['git log --oneline -5'],
        ['git status -s'],
        ['grep -rn x src'],
        ["rg -n -g '*.ts' x"],
        ["find . -name '*.ts' -type f"],
        ['npm test 2>&1 | tail -5'],
        ['ls >/dev/null'],
        ['npm test > /dev/null 2>&1'],
        ['echo done >&2'],
        ['echo x >&2'],
        ['echo x >&-'],
        ['npm test 2>&1'],
        ['npx specpilot status'],
        ['node dist/cli.js status'],
        ['pwd; echo hi'],
        ['git diff -U5'],
        ['git log --pretty=oneline'],
        ['git log --format=%h'],
        ['git diff -- --odd-path'],
      ])('%j is allowed', (command) => {
        expect(withRoles(bash(command, agentType))).toEqual(ALLOWED);
      });

      // Any backslash outside quotes is blocked: a backslash-newline continuation could otherwise hide an
      // option inside a word that does not start with "-".
      test.each([
        ['find . \\\n-delete'],
        ['find . \\\n-fprint out.txt'],
        ["find . \\\n-exec node test/x.js '{}' ';'"],
        ['rg \\\n--pre=sh x'],
        ['git diff \\\n--output=f'],
        ['npx jest \\\n--config=x.js'],
        ['echo a\\ b'],
        ['grep x src\\/a.ts'],
      ])('%j with a backslash outside quotes is blocked', (command) => {
        expectBashWriteDenied(command, agentType);
      });

      // Any unquoted glob character (*, ? or [) is blocked: the shell expands it into words the hook never sees.
      test.each([
        ['find . [-]delete'],
        ['find . ?delete'],
        ['ls src/*.ts'],
        ['cat test/a?.ts'],
        ['grep x *'],
      ])('%j with an unquoted glob is blocked', (command) => {
        expectBashWriteDenied(command, agentType);
      });

      test.each([
        ["rg -g '*.ts' x"],
        ["find . -name '*.ts' -type f"],
        ["grep -rn 'a[bc]' src"],
        ['npx jest -t "AC-1" test/x.test.ts'],
      ])('%j with a quoted glob is allowed', (command) => {
        expect(withRoles(bash(command, agentType))).toEqual(ALLOWED);
      });

      // The core loop keeps working.
      test.each([
        ['npm test'],
        ['npm test 2>&1 | tail -30'],
        ['npx jest test/x.test.ts'],
        ['npm run typecheck'],
        ['npm run build'],
      ])('core loop command %j is allowed', (command) => {
        expect(withRoles(bash(command, agentType))).toEqual(ALLOWED);
      });

      // "<>" opens a file for writing and ">|" overwrites one even with noclobber.
      test.each([['echo x <>file'], ['echo x >|file'], ['cat <>out.txt'], ['ls >|out.txt']])(
        '%j is blocked',
        (command) => {
          expectBashWriteDenied(command, agentType);
        },
      );

      // Round-2 decisions: double-quote backslashes, tsc arguments, specpilot argument formats, diff -U, and
      // a value option at the end of the command.
      test.each([
        ['echo "a\\"b"'],
        ['grep -n "a\\|b" src'],
        ['npx tsc --noEmit src/a.ts'],
        ['npx tsc --noEmit false'],
        ['npx tsc -- src/a.ts'],
        ['npx tsc --noEmit -- x'],
        ['npx specpilot mutate bug T AC-x'],
        ['npx specpilot mutate bug T ac-1'],
        ['npx specpilot mutate bug'],
        ['npx specpilot status extra'],
        ['node dist/cli.js mutate bug T AC-x'],
        ['node dist/cli.js mutate bug T ac-1'],
        ['node dist/cli.js mutate bug'],
        ['node dist/cli.js status extra'],
        ['diff -U 3 a b'],
        ['grep -e'],
        ['rg -g'],
      ])('round-2 decision: %j is blocked', (command) => {
        expectBashWriteDenied(command, agentType);
      });

      test.each([
        ["grep -nE 'a|b' src"],
        ['npx tsc src/a.ts --noEmit'],
        ['npx tsc --noEmit -p tsconfig.json'],
        ['diff -U3 a b'],
      ])('round-2 decision: %j is allowed', (command) => {
        expect(withRoles(bash(command, agentType))).toEqual(ALLOWED);
      });
    });

    // Words that are not task ids, through npx and through dist/cli.js.
    const SPECPILOT_PREFIXES = ['npx specpilot', 'node dist/cli.js'];
    const NOT_TASK_IDS = ['bug', '.x', '-x', 'x/y'];
    describe.each<[string, (task: string) => string]>([
      ['tests-agent', (task) => `tdd red ${task}`],
      ['code-agent', (task) => `mutate bug ${task} AC-1`],
    ])('task ids for %s', (agentType, subcommand) => {
      test.each(SPECPILOT_PREFIXES.flatMap((prefix) => NOT_TASK_IDS.map((task) => [`${prefix} ${subcommand(task)}`])))(
        '%j is blocked',
        (command) => {
          expectBashWriteDenied(command, agentType);
        },
      );

      test.each(SPECPILOT_PREFIXES.map((prefix) => [`${prefix} ${subcommand('TASK-101')}`]))('%j is allowed', (command) => {
        expect(withRoles(bash(command, agentType))).toEqual(ALLOWED);
      });
    });

    // Which specpilot commands each agent may run, through npx or through dist/cli.js.
    const SPECPILOT = ['npx specpilot', 'node dist/cli.js'];
    const SPECPILOT_ROLES: [string, string[], string[]][] = [
      [
        'tests-agent',
        ['status', 'tdd red T'],
        ['tdd green T', 'mutate T', 'mutate bug T AC-1', 'tdd red', 'gate T', 'reopen T red'],
      ],
      [
        'code-agent',
        ['status', 'tdd green T', 'mutate T', 'mutate bug T AC-1'],
        ['tdd red T', 'tdd green', 'mutate', 'gate T', 'reopen T red', 'spec lint x'],
      ],
    ];

    describe.each(SPECPILOT_ROLES)('specpilot for %s', (agentType, allowed, blocked) => {
      const commands = (subcommands: string[]) =>
        SPECPILOT.flatMap((prefix) => subcommands.map((subcommand) => [`${prefix} ${subcommand}`]));

      test.each(commands(allowed))('%j is allowed', (command) => {
        expect(withRoles(bash(command, agentType))).toEqual(ALLOWED);
      });

      test.each(commands(blocked))('%j is blocked', (command) => {
        expectBashWriteDenied(command, agentType);
      });

      test('node dist/cli.js gets exactly the same verdict as npx specpilot', () => {
        for (const subcommand of [...allowed, ...blocked, 'tdd red bug', 'mutate bug x/y AC-1', 'status extra']) {
          expect({ subcommand, verdict: withRoles(bash(`node dist/cli.js ${subcommand}`, agentType)) }).toEqual({
            subcommand,
            verdict: withRoles(bash(`npx specpilot ${subcommand}`, agentType)),
          });
        }
      });
    });

    test('the exact deny message starts with the agent and ends with what Bash allows', () => {
      const decision = withRoles(bash("sed -i 's/a/b/' src/x.ts", 'code-agent'));
      expect(decision.allow).toBe(false);
      expect(decision.reason).toMatch(
        /^Blocked by SpecPilot: code-agent may not run this command from Bash \(.+\)\. Only allowlisted read-only commands may run; write files with Edit or Write\. Allowed in Bash: .+/s,
      );
    });

    test.each(WRITING_AGENTS)('a read-only command off the allowlist is not described as a write for %s', (agentType) => {
      const decision = withRoles(bash('git -C sub status', agentType));
      expect(decision.allow).toBe(false);
      expect(decision.reason).toMatch(
        new RegExp(
          `^Blocked by SpecPilot: ${agentType} may not run this command from Bash \\(.+\\)\\. ` +
            'Only allowlisted read-only commands may run; write files with Edit or Write\\. Allowed in Bash: .+',
          's',
        ),
      );
      expect(decision.reason).not.toContain('may not write files');
    });

    test('a write from Bash is blocked before the role rule, even outside the agent area', () => {
      expectBashWriteDenied('rm test/a.test.ts', 'code-agent');
      expectBashWriteDenied('echo x > src/a.ts', 'tests-agent');
    });

    describe.each<[string, string | undefined]>([
      ['the main session', undefined],
      ['another agent', 'Explore'],
    ])('%s keeps the file-based rules', (_, agentType) => {
      test.each([
        'npm test',
        'cat a | grep b',
        'node -e "x"',
        'frobnicate x',
        'echo x > NOTES.md',
        'FOO=1 npm test',
        'cd sub && npm test',
        'npx specpilot gate T',
        'node dist/cli.js reopen T red',
        'ls src/*.ts',
        'echo a\\ b',
        'grep x *',
        'find . \\\n-name x',
      ])(
        '%j is still allowed',
        (command) => {
          expect(withRoles(bash(command, agentType))).toEqual(ALLOWED);
        },
      );

      test('sed -i on source code is still blocked by the role rule', () => {
        expect(withRoles(bash('sed -i s/a/b/ src/x.ts', agentType))).toEqual(ONLY_CODE_AGENT('src/x.ts'));
      });
    });

    test('without roles tests-agent and code-agent may still use any Bash command', () => {
      for (const agentType of WRITING_AGENTS) {
        expect(checkToolUse(bash('node -e "x"', agentType), root, undefined, false)).toEqual(ALLOWED);
        expect(checkToolUse(bash('frobnicate x', agentType), root)).toEqual(ALLOWED);
        expect(checkToolUse(bash("sed -i '' 's/a/b/' src/a.ts", agentType), root, undefined, false)).toEqual(ALLOWED);
      }
    });
  });

  describe('with phases', () => {
    test('in red the phase still blocks code-agent, and only tests-agent may edit tests', () => {
      writeTask('TASK-101', 'red');
      const code = withRoles(edit('src/a.ts', 'Edit', 'code-agent'));
      expect(code.allow).toBe(false);
      expect(code.reason).toContain('TASK-101 is in red');
      expect(withRoles(edit('test/a.test.ts', 'Edit', 'tests-agent'))).toEqual(ALLOWED);
      expect(withRoles(edit('test/a.test.ts', 'Edit'))).toEqual(ONLY_TESTS_AGENT('test/a.test.ts'));
    });

    test('when both the role and the phase deny, the role reason is returned', () => {
      writeTask('TASK-101', 'red');
      expect(withRoles(edit('src/a.ts', 'Edit'))).toEqual(ONLY_CODE_AGENT('src/a.ts'));
    });

    test('in green the phase blocks tests-agent, and only code-agent may edit source code', () => {
      writeTask('TASK-101', 'green');
      const tests = withRoles(edit('test/a.test.ts', 'Edit', 'tests-agent'));
      expect(tests.allow).toBe(false);
      expect(tests.reason).toContain('TASK-101 is in green');
      expect(withRoles(edit('src/a.ts', 'Edit', 'code-agent'))).toEqual(ALLOWED);
      expect(withRoles(edit('src/a.ts', 'Edit'))).toEqual(ONLY_CODE_AGENT('src/a.ts'));
    });
  });

  test('state.json is still written only by the CLI, even for code-agent', () => {
    const decision = withRoles(edit('specs/TASK-101/state.json', 'Write', 'code-agent'));
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain('specpilot gate');
  });

  test('grill-auditor may still write audit.md', () => {
    writeTask('TASK-101', 'grill');
    expect(withRoles(edit('specs/TASK-101/audit.md', 'Write', 'grill-auditor'))).toEqual(ALLOWED);
  });

  test('files outside the project are allowed', () => {
    const outside = path.join(os.tmpdir(), 'elsewhere', 'users.ts');
    expect(withRoles({ tool_name: 'Write', tool_input: { file_path: outside } })).toEqual(ALLOWED);
  });

  test('without roles the same edits are allowed', () => {
    const calls: ToolUse[] = [
      edit('src/a.ts', 'Write'),
      edit('test/a.test.ts', 'Edit', 'code-agent'),
      edit('README.md', 'Edit', 'tests-agent'),
      edit('README.md', 'Edit', 'code-agent'),
      bash('echo x > src/a.ts'),
      bash('rm test/a.test.ts', 'code-agent'),
    ];
    for (const call of calls) {
      expect(checkToolUse(call, root)).toEqual(ALLOWED);
      expect(checkToolUse(call, root, undefined, false)).toEqual(ALLOWED);
    }
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

  test('a task in mutation is told to run specpilot mutate and specpilot gate', () => {
    writeTask('TASK-101', 'mutation');
    const warning = stopWarning(root) as string;
    expect(warning).toContain('TASK-101 is in mutation');
    expect(warning).toContain('specpilot mutate TASK-101');
    expect(warning).toContain('specpilot gate TASK-101');
    expect(warning).not.toContain('not implemented');
  });

  test('the exact warnings for mutation and verify', () => {
    writeTask('TASK-101', 'mutation');
    expect(stopWarning(root)).toBe(
      'TASK-101 is in mutation, so the task is not done: run specpilot mutate TASK-101 and specpilot gate TASK-101.',
    );
    writeTask('TASK-101', 'verify');
    expect(stopWarning(root)).toBe(
      'TASK-101 is in verify, so the task is not done: run specpilot verify TASK-101.',
    );
  });

  test('a task in verify is still reported as not done and told to run specpilot verify', () => {
    writeTask('TASK-101', 'verify');
    const warning = stopWarning(root) as string;
    expect(warning).toContain('TASK-101 is in verify');
    expect(warning).toContain('run specpilot verify TASK-101');
    expect(warning).not.toContain('not implemented');
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
