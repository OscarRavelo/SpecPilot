import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEFAULT_MODELS, readModeConfig, setMode, setModelLine } from '../src/mode';

const CODE_AGENT = [
  '---',
  'name: code-agent',
  'description: Writes the code.',
  'model: haiku',
  'tools: Read, Edit, Write',
  '---',
  'You write code.',
  'model: this body line is not frontmatter',
  '',
].join('\n');

const TESTS_AGENT_NO_MODEL = ['---', 'name: tests-agent', 'tools: Read', '---', 'You write tests.', ''].join('\n');

describe('mode config', () => {
  let project: string;
  beforeEach(() => (project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-mode-config-'))));
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('AC-13: default models are sonnet for standard and opus for max', () => {
    expect(DEFAULT_MODELS).toEqual({ standard: 'sonnet', max: 'opus' });
  });

  test('AC-15: without .specpilot/config.json the mode is standard with the default models', () => {
    expect(readModeConfig(project)).toEqual({ mode: 'standard', modes: { standard: 'sonnet', max: 'opus' } });
  });

  test('AC-13: .specpilot/config.json overrides the mode and the models', () => {
    fs.mkdirSync(path.join(project, '.specpilot'));
    fs.writeFileSync(
      path.join(project, '.specpilot', 'config.json'),
      JSON.stringify({ mode: 'max', modes: { standard: 'haiku', max: 'claude-opus-5-5' } }),
    );
    expect(readModeConfig(project)).toEqual({ mode: 'max', modes: { standard: 'haiku', max: 'claude-opus-5-5' } });
  });

  // 42 is not one of the shapes AC-13 lists; it is here so a config that is valid JSON but not an object is covered too.
  test.each([
    ['not valid JSON', '{ not json'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '42'],
  ])('AC-13: a .specpilot/config.json that is %s throws "Corrupt <file>"', (_shape, text) => {
    const file = path.join(project, '.specpilot', 'config.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, text);
    let error: unknown;
    try {
      readModeConfig(project);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('Corrupt');
    expect(message).toContain(file);
    expect(message).toBe(`Corrupt ${file}`);
  });
});

describe('setModelLine', () => {
  test('AC-14: changes only the frontmatter model: line', () => {
    expect(setModelLine(CODE_AGENT, 'opus')).toBe(CODE_AGENT.replace('model: haiku', 'model: opus'));
  });

  test('AC-14: adds a model: line before the closing --- when there is none', () => {
    expect(setModelLine(TESTS_AGENT_NO_MODEL, 'opus')).toBe(
      ['---', 'name: tests-agent', 'tools: Read', 'model: opus', '---', 'You write tests.', ''].join('\n'),
    );
  });

  test('AC-14: is idempotent', () => {
    const once = setModelLine(CODE_AGENT, 'opus');
    expect(setModelLine(once, 'opus')).toBe(once);
    expect(once).not.toBe(CODE_AGENT);
  });

  test('AC-14: a file with no frontmatter throws', () => {
    expect(() => setModelLine('You write code.\nmodel: haiku\n', 'opus')).toThrow();
  });

  test('AC-14: a frontmatter that opens with --- but never closes throws', () => {
    expect(() => setModelLine('---\nname: code-agent\nmodel: haiku\nYou write code.\n', 'opus')).toThrow(
      'No frontmatter',
    );
  });

  test('AC-14: a line that only contains "model:" later on is not the model line', () => {
    const text = [
      '---',
      'name: code-agent',
      'description: Picks the model: carefully',
      'model: haiku',
      '---',
      'Body.',
      '',
    ].join('\n');
    expect(setModelLine(text, 'opus')).toBe(text.replace('model: haiku', 'model: opus'));
  });

  test('AC-14: a CRLF file keeps every \\r\\n when the model line is replaced', () => {
    const text = ['---', 'name: code-agent', 'model: haiku', 'tools: Read', '---', 'Body.', ''].join('\r\n');
    expect(setModelLine(text, 'opus')).toBe(
      ['---', 'name: code-agent', 'model: opus', 'tools: Read', '---', 'Body.', ''].join('\r\n'),
    );
  });

  test('AC-14: a CRLF file keeps every \\r\\n when the model line is added', () => {
    const text = ['---', 'name: tests-agent', 'tools: Read', '---', 'Body.', ''].join('\r\n');
    expect(setModelLine(text, 'opus')).toBe(
      ['---', 'name: tests-agent', 'tools: Read', 'model: opus', '---', 'Body.', ''].join('\r\n'),
    );
  });
});

describe('setMode', () => {
  let project: string;
  const agents = () => path.join(project, '.claude', 'agents');
  const read = (name: string) => fs.readFileSync(path.join(agents(), name), 'utf8');
  const snapshot = () =>
    Object.fromEntries(fs.readdirSync(agents()).sort().map((name) => [name, read(name)]));

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-mode-'));
    fs.mkdirSync(agents(), { recursive: true });
    fs.writeFileSync(path.join(agents(), 'code-agent.md'), CODE_AGENT);
    fs.writeFileSync(path.join(agents(), 'tests-agent.md'), CODE_AGENT.replace('code-agent', 'tests-agent'));
    fs.writeFileSync(path.join(agents(), 'notes.txt'), 'model: haiku\n');
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('AC-13: max writes model: opus and standard writes model: sonnet in every agent file', () => {
    setMode(project, 'max');
    expect(read('code-agent.md')).toContain('\nmodel: opus\n');
    expect(read('tests-agent.md')).toContain('\nmodel: opus\n');
    setMode(project, 'standard');
    expect(read('code-agent.md')).toContain('\nmodel: sonnet\n');
    expect(read('tests-agent.md')).toContain('\nmodel: sonnet\n');
    expect(read('notes.txt')).toBe('model: haiku\n');
  });

  test('AC-13: uses the models from .specpilot/config.json', () => {
    fs.mkdirSync(path.join(project, '.specpilot'));
    fs.writeFileSync(
      path.join(project, '.specpilot', 'config.json'),
      JSON.stringify({ modes: { standard: 'haiku', max: 'claude-opus-5-5' } }),
    );
    setMode(project, 'max');
    expect(read('code-agent.md')).toBe(CODE_AGENT.replace('model: haiku', 'model: claude-opus-5-5'));
  });

  test('AC-15: after setMode(project, "max"), readModeConfig reports max', () => {
    setMode(project, 'max');
    expect(readModeConfig(project)).toEqual({ mode: 'max', modes: { standard: 'sonnet', max: 'opus' } });
  });

  test('AC-15: saving the mode keeps the other keys of an existing .specpilot/config.json', () => {
    const file = path.join(project, '.specpilot', 'config.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ modes: { standard: 'haiku', max: 'claude-opus-5-5' } }));
    const changed = setMode(project, 'max');
    expect(changed).toContain(file);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      modes: { standard: 'haiku', max: 'claude-opus-5-5' },
      mode: 'max',
    });
    expect(readModeConfig(project)).toEqual({ mode: 'max', modes: { standard: 'haiku', max: 'claude-opus-5-5' } });
  });

  test('AC-14: a second setMode with the same mode changes no file and reports none', () => {
    expect(setMode(project, 'max').length).toBeGreaterThan(0);
    expect(setMode(project, 'max')).toEqual([]);
  });

  test('AC-14: a second run leaves every file byte for byte the same', () => {
    setMode(project, 'max');
    const first = snapshot();
    expect(first['code-agent.md']).toBe(CODE_AGENT.replace('model: haiku', 'model: opus'));
    setMode(project, 'max');
    expect(snapshot()).toEqual(first);
  });

  test('AC-15: an unknown mode throws naming it and the valid modes, and changes no file', () => {
    const before = snapshot();
    let error: unknown;
    try {
      setMode(project, 'turbo');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const text = (error as Error).message;
    expect(text).toContain('turbo');
    expect(text).toContain('standard');
    expect(text).toContain('max');
    expect(snapshot()).toEqual(before);
  });

  test('AC-15: an unknown mode prints exactly "Unknown mode: turbo (valid modes: standard, max)"', () => {
    const expected = 'Unknown mode: turbo (valid modes: standard, max)';
    const messageOf = (run: () => unknown): string => {
      let error: unknown;
      try {
        run();
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(Error);
      return (error as Error).message;
    };
    expect(messageOf(() => setMode(project, 'turbo'))).toBe(expected);

    fs.mkdirSync(path.join(project, '.specpilot'));
    fs.writeFileSync(path.join(project, '.specpilot', 'config.json'), JSON.stringify({ mode: 'turbo' }));
    expect(messageOf(() => readModeConfig(project))).toBe(expected);
  });

  test('AC-14: an agent file with no frontmatter makes mode fail and no file changes (all or nothing)', () => {
    fs.writeFileSync(path.join(agents(), 'z-broken.md'), 'No frontmatter here.\n');
    const before = snapshot();
    expect(() => setMode(project, 'max')).toThrow(/z-broken\.md/);
    expect(snapshot()).toEqual(before);
  });

  test.each([
    ['not valid JSON', '{ not json'],
    ['null', 'null'],
    ['an array', '[]'],
  ])('AC-13: a .specpilot/config.json that is %s makes setMode throw and changes no file', (_shape, text) => {
    const file = path.join(project, '.specpilot', 'config.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, text);
    const before = snapshot();
    expect(() => setMode(project, 'max')).toThrow(`Corrupt ${file}`);
    expect(snapshot()).toEqual(before);
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  test('AC-13: a project with no .claude/agents/ folder makes setMode throw naming it, and creates no config', () => {
    fs.rmSync(path.join(project, '.claude'), { recursive: true, force: true });
    let error: unknown;
    try {
      setMode(project, 'max');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('No agents folder');
    expect(message).toContain(agents());
    expect(message).toBe(`No agents folder: ${agents()}`);
    expect(fs.existsSync(path.join(project, '.specpilot'))).toBe(false);
    expect(fs.existsSync(path.join(project, '.claude'))).toBe(false);
  });
});
