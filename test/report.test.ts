import { countRounds, formatReport, NO_TASKS, REPORT_COLUMNS, reportRows, type ReportRow } from '../src/report';
import type { HistoryEntry, Phase } from '../src/state';
import { at, makeSandbox, removeSandbox, type Sandbox } from './cost-fixtures';
import {
  ALPHA_BETA_LINES,
  CORRUPT_STATES,
  DASH,
  HEADER,
  ROUNDS_2,
  ROUNDS_3,
  seedAlphaAndSpecOnly,
  seedAlphaBeta,
  seedCorruptHallucinations,
  seedCorruptState,
  type Move,
} from './report-fixtures';

const history = (moves: Move[]): HistoryEntry[] =>
  moves.map((move, i) => ({ from: move.from as Phase, to: move.to as Phase, at: at(`10:0${i}:00.000`) }));

describe('countRounds', () => {
  test('AC-2: plan→red, red→green, green→mutation, mutation→red, red→green is 2 rounds', () => {
    expect(countRounds(history(ROUNDS_2))).toBe(2);
  });

  test('AC-2: adding green→mutation, mutation→verify, verify→red is 3 rounds', () => {
    expect(countRounds(history(ROUNDS_3))).toBe(3);
  });

  test('AC-2: a history with no return to red is 1 round', () => {
    expect(
      countRounds(
        history([
          { from: 'plan', to: 'red' },
          { from: 'red', to: 'green' },
          { from: 'green', to: 'mutation' },
        ]),
      ),
    ).toBe(1);
  });
});

describe('formatReport', () => {
  const row = (task: string, phase: Phase, costEur: number | null, extra: Partial<ReportRow> = {}): ReportRow => ({
    task,
    phase,
    passed: phase === 'done',
    rounds: 1,
    hallucinations: 0,
    costEur,
    ...extra,
  });

  test('AC-1: the header has the 6 columns in order, separated by one tab', () => {
    expect(REPORT_COLUMNS.join('\t')).toBe(HEADER);
    expect(formatReport([row('alpha', 'done', 1.24)])[0]).toBe(HEADER);
  });

  test('AC-1: prints the header and one line per row, passed as yes/no and cost with 2 decimals', () => {
    expect(formatReport([row('alpha', 'done', 1.24), row('beta', 'green', 0.5)])).toEqual(ALPHA_BETA_LINES);
  });

  test('AC-1: prints rounds and hallucinations as given', () => {
    expect(formatReport([row('alpha', 'red', 0, { rounds: 3, hallucinations: 2 })])).toEqual([
      HEADER,
      'alpha\tred\tno\t3\t2\t0.00',
    ]);
  });

  test('AC-4: a null costEur is printed as —', () => {
    expect(formatReport([row('alpha', 'green', null)])).toEqual([HEADER, `alpha\tgreen\tno\t1\t0\t${DASH}`]);
  });

  test('AC-5: no rows prints only NO_TASKS ("no tasks found in specs/")', () => {
    expect(NO_TASKS).toBe('no tasks found in specs/');
    expect(formatReport([])).toEqual([NO_TASKS]);
  });
});

describe('reportRows', () => {
  let box: Sandbox;
  const savedHome = process.env.HOME;
  beforeEach(() => {
    box = makeSandbox('specpilot-report');
    process.env.HOME = box.home;
  });
  afterEach(() => {
    process.env.HOME = savedHome;
    removeSandbox(box);
  });

  test('AC-1: one row per task with state.json, sorted by task, with the costs in EUR', () => {
    seedAlphaBeta(box);
    expect(reportRows(box.project)).toEqual([
      { task: 'alpha', phase: 'done', passed: true, rounds: 1, hallucinations: 0, costEur: 1.24 },
      { task: 'beta', phase: 'green', passed: false, rounds: 1, hallucinations: 0, costEur: 0.5 },
    ]);
  });

  test('AC-5: a folder without state.json is skipped', () => {
    seedAlphaAndSpecOnly(box);
    expect(reportRows(box.project)).toEqual([
      { task: 'alpha', phase: 'red', passed: false, rounds: 1, hallucinations: 0, costEur: null },
    ]);
  });

  // The message of the error reportRows throws, or undefined when it does not throw.
  const thrownMessage = (): string | undefined => {
    try {
      reportRows(box.project);
    } catch (err) {
      return (err as Error).message;
    }
    return undefined;
  };

  test.each(CORRUPT_STATES)('AC-6: a state.json that %s throws an error naming specs/alpha', (_shape, text) => {
    seedCorruptState(box, text);
    expect(thrownMessage()).toBe('Corrupt state.json in specs/alpha');
  });

  test('AC-6: a hallucinations.json that is not an array throws an error naming specs/alpha and hallucinations.json', () => {
    seedCorruptHallucinations(box);
    expect(thrownMessage()).toBe('Corrupt hallucinations.json in specs/alpha');
  });
});
