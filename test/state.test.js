const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  PHASES,
  createState,
  listTasks,
  nextPhase,
  transition,
  loadState,
  saveState,
} = require('../src/state');

const NOW = new Date('2026-10-17T10:00:00.000Z');

describe('state machine', () => {
  test('phases follow the workflow order', () => {
    expect(PHASES).toEqual([
      'research',
      'grill',
      'plan',
      'red',
      'green',
      'mutation',
      'verify',
      'done',
    ]);
  });

  test('a new task starts in research with no history', () => {
    expect(createState('TASK-1')).toEqual({ taskId: 'TASK-1', phase: 'research', history: [] });
  });

  test('nextPhase returns the next phase and null at the end', () => {
    expect(nextPhase('research')).toBe('grill');
    expect(nextPhase('verify')).toBe('done');
    expect(nextPhase('done')).toBeNull();
  });

  test('nextPhase rejects unknown phases', () => {
    expect(() => nextPhase('deploy')).toThrow('Unknown phase: deploy');
  });

  test('transition moves forward, records history and does not mutate the original state', () => {
    const state = createState('TASK-1');
    const next = transition(state, 'grill', NOW);

    expect(next).toEqual({
      taskId: 'TASK-1',
      phase: 'grill',
      history: [{ from: 'research', to: 'grill', at: '2026-10-17T10:00:00.000Z' }],
    });
    expect(state).toEqual(createState('TASK-1'));
  });

  test.each([
    ['research', 'plan'],
    ['grill', 'red'],
    ['plan', 'green'],
    ['red', 'mutation'],
    ['green', 'verify'],
    ['mutation', 'done'],
    ['done', 'research'],
    ['grill', 'research'],
  ])('rejects jumping from %s to %s', (from, to) => {
    expect(() => transition({ taskId: 'T', phase: from, history: [] }, to, NOW)).toThrow(
      `Cannot move from ${from} to ${to}`,
    );
  });

  test.each([
    ['plan', 'grill'],
    ['mutation', 'red'],
    ['verify', 'red'],
  ])('allows going back from %s to %s', (from, to) => {
    const next = transition({ taskId: 'T', phase: from, history: [] }, to, NOW);
    expect(next.phase).toBe(to);
    expect(next.history).toEqual([{ from, to, at: NOW.toISOString() }]);
  });

  test('the only allowed moves are the next phase and the listed backward moves', () => {
    const backward = ['plan>grill', 'mutation>red', 'verify>red'];
    for (const from of PHASES) {
      for (const to of PHASES) {
        const allowed = to === nextPhase(from) || backward.includes(`${from}>${to}`);
        const move = () => transition({ taskId: 'T', phase: from, history: [] }, to, NOW);
        if (allowed) expect(move).not.toThrow();
        else expect(move).toThrow(`Cannot move from ${from} to ${to}`);
      }
    }
  });

  test('history accumulates across transitions', () => {
    const later = new Date('2026-10-17T11:00:00.000Z');
    const state = transition(transition(createState('T'), 'grill', NOW), 'plan', later);
    expect(state.history).toEqual([
      { from: 'research', to: 'grill', at: NOW.toISOString() },
      { from: 'grill', to: 'plan', at: later.toISOString() },
    ]);
  });

  test('rejects unknown target phases', () => {
    expect(() => transition(createState('T'), 'deploy', NOW)).toThrow('Unknown phase: deploy');
  });
});

describe('state.json persistence', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-state-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('without state.json the task is in research', () => {
    expect(loadState(dir, 'TASK-1')).toEqual(createState('TASK-1'));
  });

  test('saves and reloads the same state', () => {
    const state = transition(createState('TASK-1'), 'grill', NOW);
    saveState(dir, state);

    expect(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'))).toEqual(state);
    expect(loadState(dir, 'TASK-1')).toEqual(state);
  });

  test('a corrupt state.json fails with its path', () => {
    fs.writeFileSync(path.join(dir, 'state.json'), '{nope');
    expect(() => loadState(dir, 'TASK-1')).toThrow(`Corrupt state.json in ${dir}`);
  });

  test('a state.json with an unknown phase fails', () => {
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ taskId: 'TASK-1', phase: 'deploy', history: [] }),
    );
    expect(() => loadState(dir, 'TASK-1')).toThrow(`Corrupt state.json in ${dir}`);
  });

  test('a state.json from another task fails', () => {
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ taskId: 'TASK-2', phase: 'grill', history: [] }),
    );
    expect(() => loadState(dir, 'TASK-1')).toThrow(`Corrupt state.json in ${dir}`);
  });
});

describe('listTasks', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-tasks-'));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('a missing specs folder has no tasks', () => {
    expect(listTasks(path.join(dir, 'missing'))).toEqual([]);
  });

  test('lists task folders only, sorted even if the file system is not', () => {
    for (const name of ['TASK-2', 'TASK-10', 'TASK-1']) fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, 'README.md'), '');
    const realReaddir = fs.readdirSync;
    jest
      .spyOn(fs, 'readdirSync')
      .mockImplementation((...args) => realReaddir(...args).reverse());

    expect(listTasks(dir)).toEqual(['TASK-1', 'TASK-10', 'TASK-2']);
  });
});
