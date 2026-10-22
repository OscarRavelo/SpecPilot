import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { CHECKLISTS, checklistFor } from '../src/checklist';
import type { ChecklistItem } from '../src/checklist';
import { TASK_TYPES } from '../src/spec';

// A type the code does not know yet must fail on an assertion, not throw.
const itemsOf = (type: string): ChecklistItem[] | string => {
  try {
    return checklistFor(type);
  } catch (error) {
    return String(error);
  }
};
const idsOf = (type: string) => {
  const items = itemsOf(type);
  return typeof items === 'string' ? items : items.map((item) => item.id);
};

const CLI_COMMAND = [
  { id: 'contract', description: 'command, arguments and options, stdout, stderr and exit codes' },
  { id: 'files', description: 'which files it reads and writes, and which must never change' },
  { id: 'errors', description: 'every failure, with its exit code and message' },
  { id: 'compatibility', description: 'existing commands, options and files keep working' },
  { id: 'edge-cases', description: 'missing, empty, corrupt and repeated inputs' },
  { id: 'out-of-scope', description: 'what this task must not touch' },
];

describe('checklists', () => {
  test('AC-12: every task type has a checklist, cli-command included', () => {
    expect(Object.keys(CHECKLISTS).sort()).toEqual([...TASK_TYPES].sort());
    expect(Object.keys(CHECKLISTS).sort()).toEqual(
      ['cli-command', 'endpoint-fields', 'new-endpoint', 'react-component'],
    );
  });

  test.each([...TASK_TYPES])('%s items have unique kebab-case ids and a description', (type) => {
    const items = checklistFor(type);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    for (const item of items) {
      expect(item.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(item.description.length).toBeGreaterThan(10);
    }
  });

  test.each([
    ['new-endpoint', ['contract', 'validation', 'errors', 'data', 'auth', 'edge-cases', 'out-of-scope']],
    [
      'endpoint-fields',
      ['contract', 'validation', 'errors', 'data', 'auth', 'compatibility', 'edge-cases', 'out-of-scope'],
    ],
    [
      'react-component',
      [
        'contract',
        'states',
        'data',
        'validation',
        'errors',
        'auth',
        'accessibility',
        'compatibility',
        'edge-cases',
        'out-of-scope',
      ],
    ],
  ])('%s covers the expected items', (type, ids) => {
    expect(idsOf(type)).toEqual(ids);
  });

  test('AC-12: cli-command covers contract, files, errors, compatibility, edge-cases and out-of-scope, in order', () => {
    expect(idsOf('cli-command')).toEqual([
      'contract',
      'files',
      'errors',
      'compatibility',
      'edge-cases',
      'out-of-scope',
    ]);
  });

  test('AC-12: each cli-command item has its description from the spec', () => {
    expect(itemsOf('cli-command')).toEqual(CLI_COMMAND);
  });

  test('an unknown task type fails', () => {
    expect(() => checklistFor('microservice')).toThrow('Unknown task type: microservice');
  });
});

describe('specpilot grill checklist for a cli-command task', () => {
  const BIN = path.join(__dirname, '..', 'dist', 'cli.js');
  let project: string;

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-checklist-cli-'));
    const taskDir = path.join(project, 'specs', 'TASK-7');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, 'spec.md'),
      [
        '---',
        'id: TASK-7',
        'type: cli-command',
        '---',
        '# specpilot hello',
        '',
        '## Acceptance criteria',
        '',
        '### AC-1: Prints a greeting',
        '- Given any project',
        '- When I run specpilot hello',
        '- Then stdout is "hello"',
        '',
      ].join('\n'),
    );
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('AC-12: lists the 6 cli-command items with their descriptions, in order', () => {
    const result = spawnSync(process.execPath, [BIN, 'grill', 'checklist', 'TASK-7'], {
      encoding: 'utf8',
      cwd: project,
    });
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: '' });
    expect(result.stdout).toBe(
      [
        'TASK-7 (cli-command): 0/6 covered',
        ...CLI_COMMAND.map(({ id, description }) => `[ ] ${id}: ${description}`),
        '',
      ].join('\n'),
    );
  });
});
