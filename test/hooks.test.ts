import fs from 'fs';
import os from 'os';
import path from 'path';
import { classifyPath, checkToolUse } from '../src/hooks';
import type { ToolUse } from '../src/hooks';
import { PHASES } from '../src/state';

describe('classifyPath', () => {
  test.each([
    ['specs/TASK-101/state.json', 'state'],
    ['specs/TASK-101/audit.md', 'audit'],
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
