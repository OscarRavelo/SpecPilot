import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { readPrices } from '../src/cost';
import {
  assistant,
  at,
  bang,
  flatPrice,
  folderName,
  makeSandbox,
  MODEL,
  removeSandbox,
  seedDoneTask,
  TASK,
  TEST_PRICES,
  writePrices,
  writeState,
  writeTranscript,
  type Sandbox,
} from './cost-fixtures';

// Runs the compiled CLI with a temp HOME, so transcripts are read from <home>/.claude/projects.
const BIN = path.join(__dirname, '..', 'dist', 'cli.js');

function runCli(box: Sandbox, ...args: string[]) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: box.home, USERPROFILE: box.home };
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: box.project, env });
}

const lines = (text: string) => text.trim().split('\n');

describe('specpilot cost', () => {
  let box: Sandbox;
  beforeEach(() => (box = makeSandbox('specpilot-cost-cli')));
  afterEach(() => removeSandbox(box));

  const json = (...extra: string[]) => {
    const result = runCli(box, 'cost', TASK, '--json', ...extra);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout);
  };

  test('AC-1: totals each token type exactly', () => {
    seedDoneTask(box, [
      assistant({
        id: 'm1',
        at: at('10:00:00.000'),
        input: 100,
        output: 10,
        cacheRead: 1000,
        cacheWrite: 50,
        command: 'npx specpilot tdd red TASK-1',
      }),
      assistant({ id: 'm2', at: at('10:05:00.000'), input: 200, output: 20, cacheRead: 2000, cacheWrite: 60 }),
    ]);
    expect(json().tokens).toEqual({ input: 300, output: 30, cacheRead: 3000, cacheWrite: 110 });
  });

  test('AC-2: counts a repeated message.id once', () => {
    seedDoneTask(box, [
      assistant({ id: 'msg_1', at: at('10:10:00.000'), input: 100 }),
      assistant({ id: 'msg_1', at: at('10:10:00.000'), input: 100 }),
      assistant({ id: 'msg_1', at: at('10:10:00.000'), input: 100 }),
      assistant({ id: 'msg_2', at: at('10:11:00.000'), input: 7 }),
    ]);
    expect(json().tokens.input).toBe(107);
  });

  test('AC-2: a message.id written twice counts the output of its last copy (16 then 303 -> 303)', () => {
    seedDoneTask(box, [
      assistant({ id: 'msg_3', at: at('10:10:00.000'), output: 16 }),
      assistant({ id: 'msg_3', at: at('10:10:00.000'), output: 303 }),
    ]);
    expect(json().tokens.output).toBe(303);
  });

  test('AC-3: counts the subagent files of a session with a full-length UUID id', () => {
    const session = '7c3e9b21-5d4a-4f8e-9a6b-2e1f0d3c4b5a';
    writeState(box.project, TASK, 'done', [at('10:00:00.000'), at('11:00:00.000')]);
    writePrices(box.project);
    writeTranscript(box.dir, `${session}.jsonl`, [
      bang('npx specpilot gate TASK-1', session),
      assistant({ id: 'm_main', at: at('10:10:00.000'), sessionId: session, output: 10 }),
    ]);
    writeTranscript(box.dir, path.join(session, 'subagents', 'agent-x.jsonl'), [
      assistant({ id: 'm_sub', at: at('10:12:00.000'), sessionId: session, sidechain: true, output: 40 }),
    ]);
    expect(json().tokens.output).toBe(50);
  });

  test('AC-3: includes sidechain lines and subagent files of the task session', () => {
    seedDoneTask(box, [
      assistant({ id: 'm_main', at: at('10:10:00.000'), output: 10 }),
      assistant({ id: 'm_side', at: at('10:11:00.000'), sidechain: true, output: 20 }),
    ]);
    writeTranscript(box.dir, path.join('sess-a', 'subagents', 'agent-x.jsonl'), [
      assistant({ id: 'm_sub', at: at('10:12:00.000'), sidechain: true, output: 40 }),
    ]);
    expect(json().tokens.output).toBe(70);
  });

  test('AC-4: counts only messages of the task sessions inside the window (14)', () => {
    seedDoneTask(box, [
      assistant({ id: 'm1', at: at('09:59:59.000'), input: 1 }),
      assistant({ id: 'm2', at: at('10:00:00.000'), input: 2 }),
      assistant({ id: 'm3', at: at('10:30:00.000'), input: 4 }),
      assistant({ id: 'm4', at: at('11:00:00.000'), input: 8 }),
      assistant({ id: 'm5', at: at('11:00:01.000'), input: 16 }),
    ]);
    writeTranscript(box.dir, 'sess-b.jsonl', [
      assistant({ id: 'm_b', at: at('10:30:00.000'), sessionId: 'sess-b', input: 32 }),
    ]);
    expect(json().tokens.input).toBe(14);
  });

  test('AC-5: an unfinished task counts messages after its last transition and says it is in progress', () => {
    writeState(box.project, TASK, 'green', [at('10:00:00.000')]);
    writePrices(box.project);
    writeTranscript(box.dir, 'sess-a.jsonl', [
      bang('npx specpilot tdd red TASK-1'),
      assistant({ id: 'm_late', at: at('12:00:00.000'), input: 5 }),
    ]);

    const text = runCli(box, 'cost', TASK);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('TASK-1');
    expect(text.stdout).toContain('in progress');

    const report = json();
    expect(report.inProgress).toBe(true);
    expect(report.tokens.input).toBe(5);
  });

  test('AC-6: does not read another project folder, and a missing folder is a one-line error', () => {
    writeState(box.project, TASK, 'done', [at('10:00:00.000'), at('11:00:00.000')]);
    writePrices(box.project);
    // A sibling project whose path only adds a suffix: its folder must not be read.
    const otherDir = path.join(box.home, '.claude', 'projects', folderName(`${box.project}-2`));
    writeTranscript(otherDir, 'sess-a.jsonl', [
      bang('npx specpilot gate TASK-1'),
      assistant({ id: 'm_other', at: at('10:10:00.000'), input: 5 }),
    ]);

    const missing = runCli(box, 'cost', TASK);
    expect(missing.status).toBe(1);
    expect(missing.stdout).toBe('');
    expect(lines(missing.stderr)).toHaveLength(1);
    expect(missing.stderr).toContain(box.dir);
    expect(missing.stderr).toContain('No Claude Code transcripts');

    fs.mkdirSync(box.dir, { recursive: true });
    const empty = runCli(box, 'cost', TASK);
    expect(empty.status).toBe(1);
    expect(empty.stdout).toBe('');
    expect(empty.stderr).toContain('TASK-1 has no messages in its window');
  });

  test('AC-7: without a project prices.json, the shipped defaults are used and reported', () => {
    const defaults = readPrices(box.project);
    const model = Object.keys(defaults.prices.models)[0] ?? MODEL;
    writeState(box.project, TASK, 'done', [at('10:00:00.000'), at('11:00:00.000')]);
    writeTranscript(box.dir, 'sess-a.jsonl', [
      bang('npx specpilot gate TASK-1'),
      assistant({ id: 'm1', at: at('10:10:00.000'), model, input: 5 }),
    ]);

    const report = json();
    expect(report.prices.file).not.toBe('');
    expect(report.prices.file.startsWith(box.project)).toBe(false);
    expect(path.basename(report.prices.file)).toBe('prices.json');
    expect(fs.existsSync(report.prices.file)).toBe(true);
    expect(report.prices.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('AC-7: .specpilot/prices.json is used, its date is reported and its prices give the cost', () => {
    seedDoneTask(
      box,
      [assistant({ id: 'm1', at: at('10:10:00.000'), input: 2_000_000 })],
      { checked: '2026-01-15', usdToEur: 0.5, models: { [MODEL]: flatPrice(1) } },
    );
    const report = json();
    expect(report.prices).toEqual({
      file: path.join(box.project, '.specpilot', 'prices.json'),
      checked: '2026-01-15',
    });
    expect(report.usd).toBe(2);
    expect(report.eur).toBe(1);
  });

  describe('AC-7: invalid project prices.json', () => {
    const pricesFile = () => path.join(box.project, '.specpilot', 'prices.json');
    const expectOneLineError = () => {
      const result = runCli(box, 'cost', TASK);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(lines(result.stderr)).toHaveLength(1);
      expect(result.stderr).toContain(pricesFile());
      expect(result.stderr).not.toMatch(/NaN|null/);
      const asJson = runCli(box, 'cost', TASK, '--json');
      expect(asJson.status).toBe(1);
      expect(asJson.stdout).toBe('');
    };

    test('AC-7: a prices.json that is not valid JSON exits 1 with one line naming the file', () => {
      seedDoneTask(box, [assistant({ id: 'm1', at: at('10:10:00.000'), input: 5 })]);
      fs.writeFileSync(pricesFile(), '{ not json');
      expectOneLineError();
    });

    test('AC-7: a model entry that lacks cacheWrite exits 1 with one line naming the file and no cost', () => {
      seedDoneTask(box, [assistant({ id: 'm1', at: at('10:10:00.000'), input: 5 })]);
      fs.writeFileSync(
        pricesFile(),
        JSON.stringify({ checked: '2026-01-15', usdToEur: 0.5, models: { [MODEL]: { input: 1, output: 1, cacheRead: 1 } } }),
      );
      expectOneLineError();
    });

    test('AC-7: a model entry with a non-number price exits 1 with one line naming the file and no cost', () => {
      seedDoneTask(box, [assistant({ id: 'm1', at: at('10:10:00.000'), input: 5 })]);
      fs.writeFileSync(
        pricesFile(),
        JSON.stringify({
          checked: '2026-01-15',
          usdToEur: 0.5,
          models: { [MODEL]: { input: 1, output: 'free', cacheRead: 1, cacheWrite: 1 } },
        }),
      );
      expectOneLineError();
    });

    test.each([
      ['has no "models"', '{"checked": "2026-01-15", "usdToEur": 0.5}'],
      ['has "models": "x"', '{"checked": "2026-01-15", "usdToEur": 0.5, "models": "x"}'],
      ['has usdToEur as a string', `{"checked": "2026-01-15", "usdToEur": "0.5", "models": {"${MODEL}": {"input": 1, "output": 1, "cacheRead": 1, "cacheWrite": 1}}}`],
      ['has a price written as 1e999', `{"checked": "2026-01-15", "usdToEur": 0.5, "models": {"${MODEL}": {"input": 1e999, "output": 1, "cacheRead": 1, "cacheWrite": 1}}}`],
    ])('AC-7: a prices.json that %s exits 1 with one line naming the file and no cost', (_shape, text) => {
      seedDoneTask(box, [assistant({ id: 'm1', at: at('10:10:00.000'), input: 5 })]);
      fs.writeFileSync(pricesFile(), text);
      expectOneLineError();
      const result = runCli(box, 'cost', TASK);
      expect(result.stderr).toContain(`Corrupt prices file ${pricesFile()}`);
      expect(result.stdout).not.toContain('USD');
    });
  });

  test('AC-8: EUR comes from the unrounded USD (4,400 tokens at 1 USD/M, usdToEur 1.2 -> usd 0, eur 0.01)', () => {
    seedDoneTask(box, [assistant({ id: 'm1', at: at('10:10:00.000'), input: 4400 })], {
      checked: '2026-01-15',
      usdToEur: 1.2,
      models: { [MODEL]: flatPrice(1) },
    });
    const report = json();
    expect(report.usd).toBe(0);
    expect(report.eur).toBe(0.01);
  });

  test('AC-8: cost is summed per model and rounded once (usd 0.01, eur 0.01)', () => {
    seedDoneTask(
      box,
      [
        assistant({ id: 'a1', at: at('10:10:00.000'), model: 'model-a', input: 1666 }),
        assistant({ id: 'a2', at: at('10:11:00.000'), model: 'model-a', input: 1666 }),
        assistant({ id: 'a3', at: at('10:12:00.000'), model: 'model-a', input: 1666 }),
        assistant({ id: 'b1', at: at('10:13:00.000'), model: 'model-b', input: 1000 }),
      ],
      {
        checked: '2026-01-15',
        usdToEur: 0.9,
        models: {
          'model-a': { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
          'model-b': { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      },
    );
    const report = json();
    expect(report.usd).toBe(0.01);
    expect(report.eur).toBe(0.01);
  });

  test('AC-9: a model with no price exits 1 with one line naming it and the prices file', () => {
    seedDoneTask(box, [assistant({ id: 'm1', at: at('10:10:00.000'), model: 'claude-unknown-1', input: 5 })]);
    const result = runCli(box, 'cost', TASK);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(lines(result.stderr)).toHaveLength(1);
    expect(result.stderr).toContain('claude-unknown-1');
    expect(result.stderr).toContain(path.join(box.project, '.specpilot', 'prices.json'));
  });

  test('AC-10: latency runs from the first to the last counted message (245500 ms, 4m 05s)', () => {
    seedDoneTask(box, [
      assistant({ id: 'm1', at: at('10:00:00.000'), input: 1 }),
      assistant({ id: 'm3', at: at('10:04:05.500'), input: 1 }),
    ]);
    writeTranscript(box.dir, path.join('sess-a', 'subagents', 'agent-x.jsonl'), [
      assistant({ id: 'm2', at: at('10:02:00.000'), sidechain: true, input: 1 }),
    ]);
    expect(json().latencyMs).toBe(245500);
    const text = runCli(box, 'cost', TASK);
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Latency: 4m 05s');
  });

  test('AC-10: counted messages of the task session outside the window do not stretch latency', () => {
    seedDoneTask(box, [
      assistant({ id: 'm_before', at: at('09:30:00.000'), input: 1 }),
      assistant({ id: 'm_first', at: at('10:00:00.000'), input: 1 }),
      assistant({ id: 'm_last', at: at('10:04:05.500'), input: 1 }),
      assistant({ id: 'm_after', at: at('11:30:00.000'), input: 1 }),
    ]);
    const report = json();
    expect(report.tokens.input).toBe(2);
    expect(report.latencyMs).toBe(245500);
  });

  test('AC-11: a window with no messages exits 1 with one line and prints no cost or latency', () => {
    seedDoneTask(box, [
      assistant({ id: 'm_before', at: at('09:00:00.000'), input: 1 }),
      assistant({ id: 'm_after', at: at('12:00:00.000'), input: 1 }),
    ]);
    const result = runCli(box, 'cost', TASK);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(lines(result.stderr)).toHaveLength(1);
    expect(result.stderr).toContain('TASK-1 has no messages in its window');
    expect(result.stderr).not.toContain('Latency');
  });

  describe('AC-12 report', () => {
    beforeEach(() =>
      seedDoneTask(box, [
        assistant({ id: 'm1', at: at('10:00:00.000'), input: 1234, output: 567, cacheRead: 89012, cacheWrite: 3456 }),
        assistant({ id: 'm2', at: at('10:01:02.000') }),
      ]),
    );

    test('AC-12: --json prints one JSON object with the agreed fields', () => {
      const result = runCli(box, 'cost', TASK, '--json');
      expect(result.status).toBe(0);
      expect(lines(result.stdout)).toHaveLength(1);
      const report = JSON.parse(result.stdout);
      expect(Object.keys(report).sort()).toEqual(
        ['eur', 'inProgress', 'latencyMs', 'mode', 'prices', 'taskId', 'tokens', 'usd'],
      );
      // 94269 tokens at 1 USD per million = 0.094269 USD, 0.0471345 EUR.
      expect(report).toEqual({
        taskId: TASK,
        inProgress: false,
        tokens: { input: 1234, output: 567, cacheRead: 89012, cacheWrite: 3456 },
        usd: 0.09,
        eur: 0.05,
        latencyMs: 62000,
        mode: 'standard',
        prices: { file: path.join(box.project, '.specpilot', 'prices.json'), checked: TEST_PRICES.checked },
      });
    });

    test('AC-12: text shows tokens per type, USD and EUR, latency, mode and the prices file with its date', () => {
      const result = runCli(box, 'cost', TASK);
      expect(result.status).toBe(0);
      const out = result.stdout;
      expect(out).toContain('TASK-1');
      expect(out).toMatch(/1,?234/);
      expect(out).toMatch(/567/);
      expect(out).toMatch(/89,?012/);
      expect(out).toMatch(/3,?456/);
      expect(out).toContain('USD');
      expect(out).toContain('0.09');
      expect(out).toContain('EUR');
      expect(out).toContain('0.05');
      expect(out).toContain('Latency: 1m 02s');
      expect(out).toContain('standard');
      expect(out).toContain(path.join(box.project, '.specpilot', 'prices.json'));
      expect(out).toContain('2026-01-15');
    });
  });

  test('AC-15: cost reports mode standard when no mode was ever set', () => {
    seedDoneTask(box, [assistant({ id: 'm1', at: at('10:10:00.000'), input: 5 })]);
    expect(json().mode).toBe('standard');
  });
});

describe('specpilot mode', () => {
  let box: Sandbox;
  const agents = () => path.join(box.project, '.claude', 'agents');
  const read = (name: string) => fs.readFileSync(path.join(agents(), name), 'utf8');
  const snapshot = () =>
    Object.fromEntries(fs.readdirSync(agents()).sort().map((name) => [name, read(name)]));
  const agentFile = (name: string) =>
    ['---', `name: ${name}`, 'description: An agent.', 'model: haiku', 'tools: Read', '---', 'Body text.', ''].join('\n');

  beforeEach(() => {
    box = makeSandbox('specpilot-mode-cli');
    fs.mkdirSync(agents(), { recursive: true });
    fs.writeFileSync(path.join(agents(), 'code-agent.md'), agentFile('code-agent'));
    fs.writeFileSync(path.join(agents(), 'tests-agent.md'), agentFile('tests-agent'));
  });
  afterEach(() => removeSandbox(box));

  test('AC-13: mode max writes model: opus and mode standard writes model: sonnet', () => {
    const max = runCli(box, 'mode', 'max');
    expect(max.status).toBe(0);
    expect(read('code-agent.md')).toBe(agentFile('code-agent').replace('model: haiku', 'model: opus'));
    expect(read('tests-agent.md')).toBe(agentFile('tests-agent').replace('model: haiku', 'model: opus'));

    const standard = runCli(box, 'mode', 'standard');
    expect(standard.status).toBe(0);
    expect(read('code-agent.md')).toBe(agentFile('code-agent').replace('model: haiku', 'model: sonnet'));
    expect(read('tests-agent.md')).toBe(agentFile('tests-agent').replace('model: haiku', 'model: sonnet'));
  });

  test('AC-13: mode max uses the max model from .specpilot/config.json', () => {
    fs.mkdirSync(path.join(box.project, '.specpilot'));
    fs.writeFileSync(
      path.join(box.project, '.specpilot', 'config.json'),
      JSON.stringify({ modes: { standard: 'haiku', max: 'claude-opus-5-5' } }),
    );
    const result = runCli(box, 'mode', 'max');
    expect(result.status).toBe(0);
    expect(read('code-agent.md')).toBe(agentFile('code-agent').replace('model: haiku', 'model: claude-opus-5-5'));
    expect(read('tests-agent.md')).toBe(agentFile('tests-agent').replace('model: haiku', 'model: claude-opus-5-5'));
  });

  test('AC-14: changes only the model line, adds a missing one, and a second run changes no byte', () => {
    const noModel = ['---', 'name: tests-agent', 'tools: Read', '---', 'model: body line stays', ''].join('\n');
    fs.writeFileSync(path.join(agents(), 'tests-agent.md'), noModel);

    expect(runCli(box, 'mode', 'max').status).toBe(0);
    expect(read('code-agent.md')).toBe(agentFile('code-agent').replace('model: haiku', 'model: opus'));
    expect(read('tests-agent.md')).toBe(
      ['---', 'name: tests-agent', 'tools: Read', 'model: opus', '---', 'model: body line stays', ''].join('\n'),
    );

    const first = snapshot();
    expect(runCli(box, 'mode', 'max').status).toBe(0);
    expect(snapshot()).toEqual(first);
  });

  test('AC-15: after specpilot mode max, specpilot mode prints max and cost --json reports mode max', () => {
    expect(runCli(box, 'mode', 'max').status).toBe(0);
    const shown = runCli(box, 'mode');
    expect(shown.status).toBe(0);
    expect(shown.stdout.trim()).toBe('max');

    seedDoneTask(box, [assistant({ id: 'm1', at: at('10:10:00.000'), input: 5 })]);
    const cost = runCli(box, 'cost', TASK, '--json');
    expect(cost.stderr).toBe('');
    expect(cost.status).toBe(0);
    expect(JSON.parse(cost.stdout).mode).toBe('max');
  });

  test('AC-15: specpilot mode max keeps the other keys of .specpilot/config.json', () => {
    const file = path.join(box.project, '.specpilot', 'config.json');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify({ modes: { standard: 'haiku', max: 'claude-opus-5-5' } }));
    expect(runCli(box, 'mode', 'max').status).toBe(0);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      modes: { standard: 'haiku', max: 'claude-opus-5-5' },
      mode: 'max',
    });
    expect(runCli(box, 'mode').stdout.trim()).toBe('max');
  });

  test('AC-15: with no mode ever set, specpilot mode prints standard', () => {
    const result = runCli(box, 'mode');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe('standard');
  });

  test('AC-15: an unknown mode exits 1 with one line naming it and the valid modes, and changes no file', () => {
    const before = snapshot();
    const result = runCli(box, 'mode', 'turbo');
    expect(result.status).toBe(1);
    expect(lines(result.stderr)).toHaveLength(1);
    expect(result.stderr).toContain('turbo');
    expect(result.stderr).toContain('standard');
    expect(result.stderr).toContain('max');
    expect(snapshot()).toEqual(before);
    expect(fs.existsSync(path.join(box.project, '.specpilot', 'config.json'))).toBe(false);
  });

  describe('AC-13: a corrupt .specpilot/config.json', () => {
    const configFile = () => path.join(box.project, '.specpilot', 'config.json');

    test.each([
      ['not valid JSON', '{ not json'],
      ['null', 'null'],
      ['an array', '[]'],
    ])('AC-13: a config.json that is %s makes mode and mode max exit 1 with one line naming it, no file changed', (_shape, text) => {
      fs.mkdirSync(path.dirname(configFile()), { recursive: true });
      fs.writeFileSync(configFile(), text);
      const before = snapshot();

      for (const args of [['mode'], ['mode', 'max']]) {
        const result = runCli(box, ...args);
        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(lines(result.stderr)).toHaveLength(1);
        expect(result.stderr).toContain(configFile());
        expect(result.stderr.trim()).toBe(`Corrupt ${configFile()}`);
      }
      expect(snapshot()).toEqual(before);
      expect(fs.readFileSync(configFile(), 'utf8')).toBe(text);
    });
  });

  test('AC-13: with no .claude/agents/ folder, mode max exits 1 with one line naming it and creates no file', () => {
    fs.rmSync(path.join(box.project, '.claude'), { recursive: true, force: true });
    const result = runCli(box, 'mode', 'max');
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(lines(result.stderr)).toHaveLength(1);
    expect(result.stderr.trim()).toBe(`No agents folder: ${agents()}`);
    expect(fs.existsSync(path.join(box.project, '.specpilot'))).toBe(false);
    expect(fs.existsSync(path.join(box.project, '.claude'))).toBe(false);
  });
});
