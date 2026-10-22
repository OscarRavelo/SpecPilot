import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import {
  assistant,
  at,
  bang,
  makeSandbox,
  removeSandbox,
  writeFile,
  writeState,
  writeTranscript,
  type PriceFile,
  type Sandbox,
} from './cost-fixtures';
import {
  ALPHA_BETA_LINES,
  ALPHA_ONLY_LINES,
  asStdout,
  CORRUPT_STATES,
  EMPTY_HISTORY_LINES,
  HALLUCINATIONS_LINES,
  HEADER,
  NO_COUNTED_LINES,
  NO_FOLDER_LINES,
  ROUNDS_LINES,
  seedAlphaAndSpecOnly,
  seedAlphaBeta,
  seedCorruptHallucinations,
  seedCorruptState,
  seedEmptyHistory,
  seedHallucinations,
  seedNoCountedMessage,
  seedNoTranscriptFolder,
  seedRounds,
  seedSpecsWithoutState,
} from './report-fixtures';

// Runs the compiled CLI with a temp HOME, so transcripts are read from <home>/.claude/projects.
const BIN = path.join(__dirname, '..', 'dist', 'cli.js');
const SHIPPED_PRICES = path.join(__dirname, '..', 'templates', 'prices.json');

function runCli(box: Sandbox, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: box.home, USERPROFILE: box.home };
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: box.project, env });
}

const lines = (text: string) => text.trim().split('\n');
const NO_TASKS_STDOUT = 'no tasks found in specs/\n';

describe('specpilot report', () => {
  let box: Sandbox;
  beforeEach(() => (box = makeSandbox('specpilot-report-cli')));
  afterEach(() => removeSandbox(box));

  const expectReport = (expected: string[]) => {
    const result = runCli(box, 'report');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(asStdout(expected));
  };

  test('AC-1: prints the header and one tab-separated row per task with the 6 columns, and exits 0', () => {
    seedAlphaBeta(box);
    const result = runCli(box, 'report');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      'task\tphase\tpassed\trounds\thallucinations\tcost_eur\n' +
        'alpha\tdone\tyes\t1\t0\t1.24\n' +
        'beta\tgreen\tno\t1\t0\t0.50\n',
    );
    expect(lines(result.stdout)).toEqual(ALPHA_BETA_LINES);
  });

  test('AC-2: rounds is 2 after one return to red and 3 after two returns to red', () => {
    seedRounds(box);
    expectReport(ROUNDS_LINES);
  });

  test('AC-3: hallucinations is the number of entries in hallucinations.json (3), and 0 with no file', () => {
    seedHallucinations(box);
    expectReport(HALLUCINATIONS_LINES);
  });

  test('AC-4: a task with no counted message in its window shows — and the command exits 0', () => {
    seedNoCountedMessage(box);
    expectReport(NO_COUNTED_LINES);
  });

  test('AC-4: with no transcript folder for the project every cost_eur is — and the command exits 0', () => {
    seedNoTranscriptFolder(box);
    expect(fs.existsSync(box.dir)).toBe(false);
    expectReport(NO_FOLDER_LINES);
  });

  test('AC-4: a task whose state.json has an empty history shows — and the command exits 0', () => {
    seedEmptyHistory(box);
    expectReport(EMPTY_HISTORY_LINES);
  });

  test('AC-5: with no specs/ folder, stdout is exactly "no tasks found in specs/" and the command exits 0', () => {
    const result = runCli(box, 'report');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(NO_TASKS_STDOUT);
  });

  test('AC-5: with a specs/ folder that holds no state.json, stdout is exactly "no tasks found in specs/" and the command exits 0', () => {
    seedSpecsWithoutState(box);
    const result = runCli(box, 'report');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(NO_TASKS_STDOUT);
  });

  test('AC-5: a folder with only spec.md is not a task: stdout has the header and the alpha row only', () => {
    seedAlphaAndSpecOnly(box);
    expectReport(ALPHA_ONLY_LINES);
  });

  describe('AC-6: corrupt files', () => {
    const expectOneLineError = (stderr: string) => {
      const result = runCli(box, 'report');
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(stderr);
    };

    test.each(CORRUPT_STATES)('AC-6: a specs/alpha/state.json that %s exits 2 with one stderr line naming specs/alpha', (_shape, text) => {
      seedCorruptState(box, text);
      expectOneLineError('Corrupt state.json in specs/alpha\n');
    });

    test('AC-6: a specs/alpha/hallucinations.json that is not a JSON array exits 2 with one stderr line naming specs/alpha and hallucinations.json', () => {
      seedCorruptHallucinations(box);
      expectOneLineError('Corrupt hallucinations.json in specs/alpha\n');
    });
  });

  describe('AC-7: read-only', () => {
    // Every directory and file under the project and the home: its bytes and mtime.
    const snapshot = () => {
      const entries: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            entries[full] = 'dir';
            walk(full);
          } else {
            entries[full] = `${fs.statSync(full).mtimeMs} ${fs.readFileSync(full).toString('base64')}`;
          }
        }
      };
      walk(box.project);
      walk(box.home);
      return entries;
    };

    const projects: [string, (box: Sandbox) => void, number][] = [
      ['AC-1 alpha and beta with costs', seedAlphaBeta, 0],
      ['AC-2 rounds', seedRounds, 0],
      ['AC-3 hallucinations', seedHallucinations, 0],
      ['AC-4 no counted message', seedNoCountedMessage, 0],
      ['AC-4 no transcript folder', seedNoTranscriptFolder, 0],
      ['AC-4 empty history', seedEmptyHistory, 0],
      ['AC-5 no specs/ folder', () => undefined, 0],
      ['AC-5 specs/ with no state.json', seedSpecsWithoutState, 0],
      ['AC-5 a folder with only spec.md', seedAlphaAndSpecOnly, 0],
      ['AC-6 corrupt state.json', (b) => seedCorruptState(b, CORRUPT_STATES[0][1]), 2],
      ['AC-6 corrupt hallucinations.json', seedCorruptHallucinations, 2],
    ];

    test.each(projects)('AC-7: on the %s project, report exits as specified and every file keeps its bytes and mtime', (_name, seed, status) => {
      seed(box);
      const before = snapshot();
      const result = runCli(box, 'report');
      expect(result.status).toBe(status);
      expect(`${result.stdout}${result.stderr}`).not.toBe('');
      expect(result.stderr).not.toContain('is not implemented yet');
      expect(snapshot()).toEqual(before);
    });
  });

  describe('AC-8: prices', () => {
    const seedAlpha = (model?: string) => {
      writeState(box.project, 'alpha', 'done', [at('10:00:00.000'), at('11:00:00.000')]);
      writeTranscript(box.dir, 'sess-a.jsonl', [
        bang('npx specpilot gate alpha', 'sess-a'),
        assistant({ id: 'a1', at: at('10:10:00.000'), sessionId: 'sess-a', model, input: 1_000_000 }),
      ]);
    };

    test('AC-8: with no .specpilot/prices.json the cost uses the prices shipped with SpecPilot and the command exits 0', () => {
      const shipped: PriceFile = JSON.parse(fs.readFileSync(SHIPPED_PRICES, 'utf8'));
      const [model, price] = Object.entries(shipped.models)[0];
      const usd = (1_000_000 * price.input) / 1_000_000;
      const eur = (Math.round(usd * shipped.usdToEur * 100) / 100).toFixed(2);
      seedAlpha(model);
      expect(fs.existsSync(path.join(box.project, '.specpilot', 'prices.json'))).toBe(false);

      const result = runCli(box, 'report');
      expect(result.status).toBe(0);
      expect(result.stdout).toBe(asStdout([HEADER, `alpha\tdone\tyes\t1\t0\t${eur}`]));
    });

    const expectSameErrorAsCost = () => {
      const cost = runCli(box, 'cost', 'alpha');
      expect(cost.status).toBe(1);
      expect(lines(cost.stderr)).toHaveLength(1);
      expect(cost.stderr.trim()).not.toBe('');

      const result = runCli(box, 'report');
      expect(result.status).toBe(2);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe(cost.stderr);
    };

    test('AC-8: a .specpilot/prices.json that is not valid exits 2 with the one stderr line that specpilot cost prints', () => {
      seedAlpha();
      writeFile(path.join(box.project, '.specpilot', 'prices.json'), '{ not json');
      expectSameErrorAsCost();
    });

    test('AC-8: a counted message of a model with no price exits 2 with the one stderr line that specpilot cost prints', () => {
      seedAlpha('claude-unknown-1');
      writeFile(
        path.join(box.project, '.specpilot', 'prices.json'),
        `${JSON.stringify({ checked: '2026-01-15', usdToEur: 0.5, models: { 'claude-sonnet-5-5': { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 } } })}\n`,
      );
      expectSameErrorAsCost();
    });
  });
});
