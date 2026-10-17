import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

const CLAUDE = path.join(__dirname, '..', 'templates', '.claude');
const SKILL = path.join(CLAUDE, 'skills', 'sp-grill', 'SKILL.md');
const AUDITOR = path.join(CLAUDE, 'agents', 'grill-auditor.md');
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

// Commands listed by --help, e.g. "gate", "ledger check", "tdd red|green".
const KNOWN = new Set([...HELP.matchAll(/^  ([a-z]+(?: [a-z|]+)?)/gm)].map((m) => m[1]));

// The prompts must not tell the agent to run commands that do not exist.
function specpilotCommands(text: string): string[] {
  return [...text.matchAll(/specpilot ([a-z]+(?: [a-z]+)?)/g)].map((m) => m[1]);
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
  expect([...KNOWN]).toEqual(expect.arrayContaining(['gate', 'spec lint', 'ledger check']));
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
