import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  computeCost,
  costReport,
  dedupeMessages,
  DEFAULT_PRICES_FILE,
  inWindow,
  latencyMs,
  parseTranscript,
  readPrices,
  runsTaskCommand,
  taskMessages,
  taskWindow,
  totalTokens,
  transcriptDir,
  type Prices,
  type TranscriptMessage,
} from '../src/cost';
import type { TaskState } from '../src/state';
import {
  assistant,
  at,
  bang,
  flatPrice,
  jsonl,
  makeSandbox,
  MODEL,
  removeSandbox,
  seedDoneTask,
  TASK,
  writePrices,
  writeState,
  writeTranscript,
  type Sandbox,
} from './cost-fixtures';

const message = (over: Partial<TranscriptMessage> & { id: string }): TranscriptMessage => ({
  model: MODEL,
  at: at('10:00:00.000'),
  sessionId: 'sess-a',
  sidechain: false,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...over,
});

const ids = (messages: TranscriptMessage[]) => messages.map((m) => m.id);

describe('transcriptDir', () => {
  test('AC-6: replaces every character that is not a letter or a digit with -', () => {
    expect(transcriptDir('/Users/me/my.app', '/home/x')).toBe(
      path.join('/home/x', '.claude', 'projects', '-Users-me-my-app'),
    );
    expect(transcriptDir('/a_b c/D9~e', '/h')).toBe(path.join('/h', '.claude', 'projects', '-a-b-c-D9-e'));
  });

  test('AC-6: home defaults to os.homedir()', () => {
    expect(transcriptDir('/Users/me/app')).toBe(
      path.join(os.homedir(), '.claude', 'projects', '-Users-me-app'),
    );
  });
});

describe('parseTranscript', () => {
  test('AC-1: maps an assistant line with usage to a message with the four token types', () => {
    const text = jsonl([
      assistant({ id: 'msg_1', at: at('10:01:00.000'), input: 100, output: 10, cacheRead: 1000, cacheWrite: 50 }),
    ]);
    expect(parseTranscript(text)).toEqual([
      {
        id: 'msg_1',
        model: MODEL,
        at: at('10:01:00.000'),
        sessionId: 'sess-a',
        sidechain: false,
        tokens: { input: 100, output: 10, cacheRead: 1000, cacheWrite: 50 },
      },
    ]);
  });

  test('AC-1: skips user lines, assistant lines without usage and <synthetic> messages', () => {
    const text = jsonl([
      bang('npx specpilot gate TASK-1'),
      assistant({ id: 'msg_nousage', at: at('10:01:00.000'), usage: false }),
      assistant({ id: 'msg_synth', at: at('10:02:00.000'), model: '<synthetic>', input: 9 }),
      assistant({ id: 'msg_ok', at: at('10:03:00.000'), input: 3 }),
      JSON.stringify({ type: 'summary', summary: 'x', leafUuid: 'u' }),
    ]);
    expect(ids(parseTranscript(text))).toEqual(['msg_ok']);
  });

  test('AC-3: reads sidechain from isSidechain and keeps the parent sessionId', () => {
    const text = jsonl([
      assistant({ id: 'msg_side', at: at('10:01:00.000'), sessionId: 'sess-p', sidechain: true, output: 20 }),
    ]);
    const [parsed] = parseTranscript(text);
    expect(parsed).toMatchObject({ id: 'msg_side', sessionId: 'sess-p', sidechain: true });
  });
});

describe('runsTaskCommand', () => {
  const viaBash = (command: string) =>
    jsonl([assistant({ id: 'msg_cmd', at: at('10:00:00.000'), command })]);

  test.each([
    'npx specpilot gate TASK-1',
    'specpilot tdd red TASK-1',
    'npx specpilot tdd green TASK-1 && npm test',
    'npx specpilot mutate TASK-1',
    'npx specpilot mutate bug TASK-1 AC-2',
    'npx specpilot verify TASK-1',
    'npx specpilot reopen TASK-1 red',
  ])('AC-4: a Bash tool call running "%s" names the task', (command) => {
    expect(runsTaskCommand(viaBash(command), 'TASK-1')).toBe(true);
  });

  test('AC-4: a ! command running specpilot gate names the task', () => {
    expect(runsTaskCommand(jsonl([bang('npx specpilot gate TASK-1')]), 'TASK-1')).toBe(true);
  });

  test('AC-4: TASK-12 does not match TASK-1 (whole id)', () => {
    expect(runsTaskCommand(viaBash('npx specpilot gate TASK-12'), 'TASK-1')).toBe(false);
    expect(runsTaskCommand(jsonl([bang('npx specpilot tdd red TASK-12')]), 'TASK-1')).toBe(false);
    expect(runsTaskCommand(viaBash('npx specpilot gate TASK-1'), 'TASK-1')).toBe(true);
  });

  test('AC-4: other commands and plain text mentions do not name the task', () => {
    expect(runsTaskCommand(viaBash('npx specpilot status'), 'TASK-1')).toBe(false);
    expect(runsTaskCommand(viaBash('echo TASK-1'), 'TASK-1')).toBe(false);
    const prose = jsonl([
      JSON.stringify({
        type: 'assistant',
        sessionId: 'sess-a',
        isSidechain: false,
        timestamp: at('10:00:00.000'),
        message: {
          id: 'msg_txt',
          model: MODEL,
          content: [{ type: 'text', text: 'Next I will run specpilot gate TASK-1.' }],
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      }),
    ]);
    expect(runsTaskCommand(prose, 'TASK-1')).toBe(false);
    expect(runsTaskCommand(jsonl([bang('npx specpilot gate TASK-1')]), 'TASK-1')).toBe(true);
  });
});

describe('dedupeMessages', () => {
  test('AC-2: keeps the first copy of each message.id, in order', () => {
    const input = [
      message({ id: 'msg_1', tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      message({ id: 'msg_2', tokens: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      message({ id: 'msg_1', tokens: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0 } }),
      message({ id: 'msg_1', tokens: { input: 60, output: 0, cacheRead: 0, cacheWrite: 0 } }),
    ];
    const result = dedupeMessages(input);
    expect(ids(result)).toEqual(['msg_1', 'msg_2']);
    expect(result[0].tokens.input).toBe(100);
    expect(totalTokens(result).input).toBe(107);
  });
});

describe('taskWindow', () => {
  const done: TaskState = {
    taskId: 'TASK-1',
    phase: 'done',
    history: [
      { from: 'research', to: 'grill', at: at('10:00:00.000') },
      { from: 'grill', to: 'plan', at: at('10:20:00.000') },
      { from: 'verify', to: 'done', at: at('11:00:00.000') },
    ],
  };

  test('AC-4: a done task runs from the first to the last history entry', () => {
    expect(taskWindow(done, new Date(at('15:00:00.000')))).toEqual({
      start: at('10:00:00.000'),
      end: at('11:00:00.000'),
      inProgress: false,
    });
  });

  test('AC-5: a task that is not done ends now and is in progress', () => {
    const green: TaskState = {
      taskId: 'TASK-1',
      phase: 'green',
      history: [{ from: 'red', to: 'green', at: at('10:00:00.000') }],
    };
    expect(taskWindow(green, new Date(at('12:34:56.789')))).toEqual({
      start: at('10:00:00.000'),
      end: at('12:34:56.789'),
      inProgress: true,
    });
  });

  test('AC-4: a task with no history has no window and throws', () => {
    const fresh: TaskState = { taskId: 'TASK-1', phase: 'research', history: [] };
    expect(() => taskWindow(fresh, new Date(at('12:00:00.000')))).toThrow(/TASK-1/);
  });
});

describe('inWindow', () => {
  test('AC-4: keeps messages inside the window, both ends included', () => {
    const messages = [
      message({ id: 'before', at: at('09:59:59.999') }),
      message({ id: 'start', at: at('10:00:00.000') }),
      message({ id: 'middle', at: at('10:30:00.000') }),
      message({ id: 'end', at: at('11:00:00.000') }),
      message({ id: 'after', at: at('11:00:00.001') }),
    ];
    const window = { start: at('10:00:00.000'), end: at('11:00:00.000'), inProgress: false };
    expect(ids(inWindow(messages, window))).toEqual(['start', 'middle', 'end']);
  });
});

describe('totalTokens', () => {
  test('AC-1: sums each token type', () => {
    const messages = [
      message({ id: 'a', tokens: { input: 100, output: 10, cacheRead: 1000, cacheWrite: 50 } }),
      message({ id: 'b', tokens: { input: 200, output: 20, cacheRead: 2000, cacheWrite: 60 } }),
    ];
    expect(totalTokens(messages)).toEqual({ input: 300, output: 30, cacheRead: 3000, cacheWrite: 110 });
  });
});

describe('readPrices', () => {
  let box: Sandbox;
  beforeEach(() => (box = makeSandbox('specpilot-prices')));
  afterEach(() => removeSandbox(box));

  test('AC-7: without a project file, the shipped defaults are used and have a YYYY-MM-DD checked date', () => {
    expect(DEFAULT_PRICES_FILE).not.toBe('');
    expect(fs.existsSync(DEFAULT_PRICES_FILE)).toBe(true);
    const { prices, file } = readPrices(box.project);
    expect(file).toBe(DEFAULT_PRICES_FILE);
    expect(prices.checked).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(prices.usdToEur).toBeGreaterThan(0);
    expect(Object.keys(prices.models).length).toBeGreaterThan(0);
  });

  test('AC-7: .specpilot/prices.json replaces the defaults whole', () => {
    const own = {
      checked: '2026-01-15',
      usdToEur: 0.5,
      models: { 'claude-only-here-1': flatPrice(2) },
    };
    const projectFile = writePrices(box.project, own);
    const { prices, file } = readPrices(box.project);
    expect(file).toBe(projectFile);
    expect(prices).toEqual(own);
  });
});

describe('computeCost', () => {
  const prices: Prices = {
    checked: '2026-01-15',
    usdToEur: 0.9,
    models: {
      'model-a': { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      'model-b': { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  };
  const tokens = (input: number) => ({ input, output: 0, cacheRead: 0, cacheWrite: 0 });

  test('AC-8: sums per model and rounds once (0.007998 USD -> 0.01, 0.0071982 EUR -> 0.01)', () => {
    const messages = [
      message({ id: 'a1', model: 'model-a', tokens: tokens(1666) }),
      message({ id: 'a2', model: 'model-a', tokens: tokens(1666) }),
      message({ id: 'a3', model: 'model-a', tokens: tokens(1666) }),
      message({ id: 'b1', model: 'model-b', tokens: tokens(1000) }),
    ];
    expect(computeCost(messages, prices, '/p/prices.json')).toEqual({ usd: 0.01, eur: 0.01 });
  });

  test('AC-8: prices each token type with its own rate', () => {
    const own: Prices = {
      checked: '2026-01-15',
      usdToEur: 0.5,
      models: { [MODEL]: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
    };
    const messages = [
      message({ id: 'x', tokens: { input: 1_000_000, output: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 } }),
    ];
    expect(computeCost(messages, own, '/p/prices.json')).toEqual({ usd: 10, eur: 5 });
  });

  test('AC-9: a model with no price throws naming the model and the prices file', () => {
    const messages = [message({ id: 'u', model: 'claude-unknown-1', tokens: tokens(10) })];
    expect(() => computeCost(messages, prices, '/p/.specpilot/prices.json')).toThrow(
      /claude-unknown-1.*\/p\/\.specpilot\/prices\.json|\/p\/\.specpilot\/prices\.json.*claude-unknown-1/,
    );
  });
});

describe('latencyMs', () => {
  test('AC-10: runs from the first to the last message, whatever their order', () => {
    const messages = [
      message({ id: 'a', at: at('10:00:00.000') }),
      message({ id: 'c', at: at('10:04:05.500') }),
      message({ id: 'b', at: at('10:02:00.000'), sidechain: true }),
    ];
    expect(latencyMs(messages)).toBe(245500);
  });
});

describe('taskMessages', () => {
  let box: Sandbox;
  beforeEach(() => (box = makeSandbox('specpilot-taskmsg')));
  afterEach(() => removeSandbox(box));

  test('AC-3: includes the main file, its sidechain lines and the session subagent files', () => {
    writeTranscript(box.dir, 'sess-a.jsonl', [
      bang('npx specpilot gate TASK-1'),
      assistant({ id: 'm_main', at: at('10:10:00.000'), output: 10 }),
      assistant({ id: 'm_side', at: at('10:11:00.000'), sidechain: true, output: 20 }),
    ]);
    writeTranscript(box.dir, path.join('sess-a', 'subagents', 'agent-x.jsonl'), [
      assistant({ id: 'm_sub', at: at('10:12:00.000'), sidechain: true, output: 40 }),
    ]);
    const result = taskMessages(box.dir, 'TASK-1');
    expect(ids(result).sort()).toEqual(['m_main', 'm_side', 'm_sub']);
    expect(totalTokens(result).output).toBe(70);
  });

  test('AC-4: leaves out sessions that never run a specpilot command for the task, and their subagents', () => {
    writeTranscript(box.dir, 'sess-a.jsonl', [
      assistant({ id: 'm_cmd', at: at('10:00:00.000'), input: 1, command: 'npx specpilot tdd red TASK-1' }),
    ]);
    writeTranscript(box.dir, 'sess-b.jsonl', [
      bang('npx specpilot gate TASK-12', 'sess-b'),
      assistant({ id: 'm_other', at: at('10:30:00.000'), sessionId: 'sess-b', input: 32 }),
    ]);
    writeTranscript(box.dir, path.join('sess-b', 'subagents', 'agent-y.jsonl'), [
      assistant({ id: 'm_other_sub', at: at('10:31:00.000'), sessionId: 'sess-b', sidechain: true, input: 64 }),
    ]);
    expect(ids(taskMessages(box.dir, 'TASK-1'))).toEqual(['m_cmd']);
  });

  test('AC-2: counts a message.id repeated in the transcript once', () => {
    writeTranscript(box.dir, 'sess-a.jsonl', [
      bang('npx specpilot gate TASK-1'),
      assistant({ id: 'msg_1', at: at('10:10:00.000'), input: 100 }),
      assistant({ id: 'msg_1', at: at('10:10:00.000'), input: 100 }),
      assistant({ id: 'msg_1', at: at('10:10:00.000'), input: 100 }),
      assistant({ id: 'msg_2', at: at('10:11:00.000'), input: 7 }),
    ]);
    expect(totalTokens(taskMessages(box.dir, 'TASK-1')).input).toBe(107);
  });
});

describe('costReport', () => {
  let box: Sandbox;
  beforeEach(() => (box = makeSandbox('specpilot-report')));
  afterEach(() => removeSandbox(box));

  test('AC-1: reports the totals, cost, latency, mode and prices of a done task', () => {
    seedDoneTask(box, [
      assistant({ id: 'm1', at: at('10:00:00.000'), input: 100, output: 10, cacheRead: 1000, cacheWrite: 50 }),
      assistant({ id: 'm2', at: at('10:01:00.000'), input: 200, output: 20, cacheRead: 2000, cacheWrite: 60 }),
    ]);
    const report = costReport(box.project, TASK, new Date(at('15:00:00.000')), box.home);
    expect(report).toEqual({
      taskId: TASK,
      inProgress: false,
      tokens: { input: 300, output: 30, cacheRead: 3000, cacheWrite: 110 },
      usd: 0,
      eur: 0,
      latencyMs: 60000,
      mode: 'standard',
      prices: { file: path.join(box.project, '.specpilot', 'prices.json'), checked: '2026-01-15' },
    });
  });

  test('AC-4: counts only the task sessions inside the window (14)', () => {
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
    expect(costReport(box.project, TASK, new Date(at('15:00:00.000')), box.home).tokens.input).toBe(14);
  });

  test('AC-5: an unfinished task counts messages up to now and is in progress', () => {
    writeState(box.project, TASK, 'green', [at('10:00:00.000')]);
    writePrices(box.project);
    writeTranscript(box.dir, 'sess-a.jsonl', [
      bang('npx specpilot tdd red TASK-1'),
      assistant({ id: 'm_late', at: at('12:00:00.000'), input: 5 }),
    ]);
    const report = costReport(box.project, TASK, new Date(at('13:00:00.000')), box.home);
    expect(report.inProgress).toBe(true);
    expect(report.tokens.input).toBe(5);
  });

  test('AC-6: a missing transcript folder throws naming it', () => {
    writeState(box.project, TASK, 'done', [at('10:00:00.000'), at('11:00:00.000')]);
    writePrices(box.project);
    expect(() => costReport(box.project, TASK, new Date(at('15:00:00.000')), box.home)).toThrow(box.dir);
  });

  test('AC-11: a window with no counted messages throws saying so', () => {
    seedDoneTask(box, [assistant({ id: 'm_out', at: at('12:00:00.000'), input: 5 })]);
    expect(() => costReport(box.project, TASK, new Date(at('15:00:00.000')), box.home)).toThrow(
      /TASK-1 has no messages in its window/,
    );
  });

  test('AC-15: reports mode standard when no mode was ever set', () => {
    seedDoneTask(box, [assistant({ id: 'm1', at: at('10:10:00.000'), input: 5 })]);
    expect(costReport(box.project, TASK, new Date(at('15:00:00.000')), box.home).mode).toBe('standard');
  });

  test('AC-9: a model with no price throws naming the model and the prices file', () => {
    seedDoneTask(box, [assistant({ id: 'm1', at: at('10:10:00.000'), model: 'claude-unknown-1', input: 5 })]);
    const file = path.join(box.project, '.specpilot', 'prices.json');
    let error: unknown;
    try {
      costReport(box.project, TASK, new Date(at('15:00:00.000')), box.home);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('claude-unknown-1');
    expect((error as Error).message).toContain(file);
  });
});
