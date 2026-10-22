import fs from 'fs';
import path from 'path';
import {
  assistant,
  at,
  bang,
  writeFile,
  writePrices,
  writeState,
  writeTranscript,
  type Sandbox,
} from './cost-fixtures';

// Hand-built projects for the step-11 (`specpilot report`) tests.

export const HEADER = 'task\tphase\tpassed\trounds\thallucinations\tcost_eur';
export const DASH = '—';

export interface Move {
  from: string;
  to: string;
}

// specs/<taskId>/state.json with the given phase and one history entry per move, a minute apart.
export function writeHistory(project: string, taskId: string, phase: string, moves: Move[]): void {
  const history = moves.map((move, i) => ({ ...move, at: at(`10:${String(i).padStart(2, '0')}:00.000`) }));
  writeFile(
    path.join(project, 'specs', taskId, 'state.json'),
    `${JSON.stringify({ taskId, phase, history }, null, 2)}\n`,
  );
}

export const ROUNDS_2: Move[] = [
  { from: 'plan', to: 'red' },
  { from: 'red', to: 'green' },
  { from: 'green', to: 'mutation' },
  { from: 'mutation', to: 'red' },
  { from: 'red', to: 'green' },
];

export const ROUNDS_3: Move[] = [
  ...ROUNDS_2,
  { from: 'green', to: 'mutation' },
  { from: 'mutation', to: 'verify' },
  { from: 'verify', to: 'red' },
];

// AC-1: alpha done (window 10:00 to 11:00) costs 2,480,000 tokens at 1 USD/M and 0.5 EUR/USD = 1.24 EUR;
// beta green (window from 12:00 to now) costs 1,000,000 tokens = 0.50 EUR.
export function seedAlphaBeta(box: Sandbox): void {
  writeState(box.project, 'alpha', 'done', [at('10:00:00.000'), at('11:00:00.000')]);
  writeState(box.project, 'beta', 'green', [at('12:00:00.000')]);
  writePrices(box.project);
  writeTranscript(box.dir, 'sess-a.jsonl', [
    bang('npx specpilot gate alpha', 'sess-a'),
    assistant({ id: 'a1', at: at('10:10:00.000'), sessionId: 'sess-a', input: 2_000_000 }),
    assistant({ id: 'a2', at: at('10:20:00.000'), sessionId: 'sess-a', output: 480_000 }),
  ]);
  writeTranscript(box.dir, 'sess-b.jsonl', [
    bang('npx specpilot tdd red beta', 'sess-b'),
    assistant({ id: 'b1', at: at('12:30:00.000'), sessionId: 'sess-b', input: 1_000_000 }),
  ]);
}

export const ALPHA_BETA_LINES = [HEADER, 'alpha\tdone\tyes\t1\t0\t1.24', 'beta\tgreen\tno\t1\t0\t0.50'];

// AC-2: two tasks with returns to red, no transcripts.
export function seedRounds(box: Sandbox): void {
  writeHistory(box.project, 'r2', 'green', ROUNDS_2);
  writeHistory(box.project, 'r3', 'red', ROUNDS_3);
}

export const ROUNDS_LINES = [HEADER, `r2\tgreen\tno\t2\t0\t${DASH}`, `r3\tred\tno\t3\t0\t${DASH}`];

export const hallucination = (n: number) => ({
  taskId: 'alpha',
  at: at(`10:0${n}:00.000`),
  phase: 'verify',
  reasons: [`reason ${n}`],
});

// AC-3: alpha has 3 hallucinations, beta has no hallucinations.json; no transcripts.
export function seedHallucinations(box: Sandbox): void {
  writeHistory(box.project, 'alpha', 'verify', [{ from: 'plan', to: 'red' }]);
  writeHistory(box.project, 'beta', 'verify', [{ from: 'plan', to: 'red' }]);
  writeFile(
    path.join(box.project, 'specs', 'alpha', 'hallucinations.json'),
    `${JSON.stringify([hallucination(1), hallucination(2), hallucination(3)], null, 2)}\n`,
  );
}

export const HALLUCINATIONS_LINES = [HEADER, `alpha\tverify\tno\t1\t3\t${DASH}`, `beta\tverify\tno\t1\t0\t${DASH}`];

// AC-4: alpha costs 1.24 EUR; beta's session only has a message before beta's window.
export function seedNoCountedMessage(box: Sandbox): void {
  writeState(box.project, 'alpha', 'done', [at('10:00:00.000'), at('11:00:00.000')]);
  writeState(box.project, 'beta', 'green', [at('12:00:00.000')]);
  writePrices(box.project);
  writeTranscript(box.dir, 'sess-a.jsonl', [
    bang('npx specpilot gate alpha', 'sess-a'),
    assistant({ id: 'a1', at: at('10:10:00.000'), sessionId: 'sess-a', input: 2_480_000 }),
  ]);
  writeTranscript(box.dir, 'sess-b.jsonl', [
    bang('npx specpilot tdd red beta', 'sess-b'),
    assistant({ id: 'b1', at: at('11:30:00.000'), sessionId: 'sess-b', input: 1_000_000 }),
  ]);
}

export const NO_COUNTED_LINES = [HEADER, 'alpha\tdone\tyes\t1\t0\t1.24', `beta\tgreen\tno\t1\t0\t${DASH}`];

// AC-4: the AC-1 tasks and prices, but no transcript folder for the project.
export function seedNoTranscriptFolder(box: Sandbox): void {
  seedAlphaBeta(box);
  fs.rmSync(box.dir, { recursive: true, force: true });
}

export const NO_FOLDER_LINES = [HEADER, `alpha\tdone\tyes\t1\t0\t${DASH}`, `beta\tgreen\tno\t1\t0\t${DASH}`];

// AC-4: alpha has an empty history; its session has messages and it would cost something if it had a window.
export function seedEmptyHistory(box: Sandbox): void {
  writeHistory(box.project, 'alpha', 'research', []);
  writePrices(box.project);
  writeTranscript(box.dir, 'sess-a.jsonl', [
    bang('npx specpilot gate alpha', 'sess-a'),
    assistant({ id: 'a1', at: at('10:10:00.000'), sessionId: 'sess-a', input: 2_000_000 }),
  ]);
}

export const EMPTY_HISTORY_LINES = [HEADER, `alpha\tresearch\tno\t1\t0\t${DASH}`];

// AC-5: alpha has a state.json, beta only a spec.md.
export function seedAlphaAndSpecOnly(box: Sandbox): void {
  writeHistory(box.project, 'alpha', 'red', [{ from: 'plan', to: 'red' }]);
  writeFile(path.join(box.project, 'specs', 'beta', 'spec.md'), '# beta\n');
}

export const ALPHA_ONLY_LINES = [HEADER, `alpha\tred\tno\t1\t0\t${DASH}`];

// AC-5: a specs/ folder with no state.json in it.
export function seedSpecsWithoutState(box: Sandbox): void {
  writeFile(path.join(box.project, 'specs', 'beta', 'spec.md'), '# beta\n');
}

// AC-6: the four corrupt state.json shapes that loadState rejects.
export const CORRUPT_STATES: [string, string][] = [
  ['is not valid JSON', '{ not json'],
  ['has a taskId other than alpha', JSON.stringify({ taskId: 'gamma', phase: 'red', history: [] })],
  ['has an unknown phase', JSON.stringify({ taskId: 'alpha', phase: 'testing', history: [] })],
  ['has a history that is not an array', JSON.stringify({ taskId: 'alpha', phase: 'red', history: {} })],
];

export function seedCorruptState(box: Sandbox, text: string): void {
  writeHistory(box.project, 'beta', 'red', [{ from: 'plan', to: 'red' }]);
  writeFile(path.join(box.project, 'specs', 'alpha', 'state.json'), text);
}

export function seedCorruptHallucinations(box: Sandbox): void {
  writeHistory(box.project, 'alpha', 'verify', [{ from: 'plan', to: 'red' }]);
  writeFile(path.join(box.project, 'specs', 'alpha', 'hallucinations.json'), '{"entries": []}\n');
}

export const asStdout = (lines: string[]) => `${lines.join('\n')}\n`;
