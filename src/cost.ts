import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadState } from './state';
import type { TaskState } from './state';
import { readModeConfig } from './mode';

// Token counts for one message or a sum of messages.
export interface Tokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

// USD per million tokens.
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Prices {
  checked: string;
  usdToEur: number;
  models: Record<string, ModelPrice>;
}

// One assistant message read from a Claude Code transcript.
export interface TranscriptMessage {
  id: string;
  model: string;
  at: string;
  sessionId: string;
  sidechain: boolean;
  tokens: Tokens;
}

export interface TaskWindow {
  start: string;
  end: string;
  inProgress: boolean;
}

export interface CostReport {
  taskId: string;
  inProgress: boolean;
  tokens: Tokens;
  usd: number;
  eur: number;
  latencyMs: number;
  mode: string;
  prices: { file: string; checked: string };
}

const TOKEN_TYPES = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function zeroTokens(): Tokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

// Claude Code keeps each project's transcripts in a folder named after its path, with every non-alphanumeric character as '-'.
export function transcriptDir(projectRoot: string, home: string = os.homedir()): string {
  return path.join(home, '.claude', 'projects', projectRoot.replace(/[^A-Za-z0-9]/g, '-'));
}

// The parts of a transcript line that are read; Claude Code writes many more.
interface TranscriptLine {
  type?: string;
  sessionId?: string;
  isSidechain?: boolean;
  timestamp?: string;
  uuid?: string;
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

interface ContentBlock {
  type?: string;
  name?: string;
  input?: { command?: unknown };
}

// JSONL lines; a line that is not JSON (e.g. a transcript cut mid-write) is skipped.
function jsonLines(text: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') lines.push(value);
    } catch {
      // not JSON
    }
  }
  return lines;
}

// Counted messages: assistant lines with usage, except Claude Code's own <synthetic> ones.
export function parseTranscript(text: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  for (const line of jsonLines(text)) {
    const message = line.message;
    const usage = message?.usage;
    if (line.type !== 'assistant' || !message || typeof usage !== 'object' || !usage) continue;
    if (message.model === '<synthetic>') continue;
    messages.push({
      id: message.id ?? line.uuid ?? '',
      model: message.model ?? '',
      at: line.timestamp ?? '',
      sessionId: line.sessionId ?? '',
      sidechain: line.isSidechain === true,
      tokens: {
        input: usage.input_tokens ?? 0,
        output: usage.output_tokens ?? 0,
        cacheRead: usage.cache_read_input_tokens ?? 0,
        cacheWrite: usage.cache_creation_input_tokens ?? 0,
      },
    });
  }
  return messages;
}

// The shell commands of a transcript: Bash tool calls and `!` commands.
function commands(text: string): string[] {
  const found: string[] = [];
  for (const line of jsonLines(text)) {
    const content = line.message?.content;
    if (line.type === 'assistant' && Array.isArray(content)) {
      for (const item of content as (ContentBlock | null)[]) {
        const command = item?.input?.command;
        if (item?.type === 'tool_use' && item.name === 'Bash' && typeof command === 'string') found.push(command);
      }
    }
    if (line.type === 'user' && typeof content === 'string') {
      for (const match of content.matchAll(/<bash-input>([\s\S]*?)<\/bash-input>/g)) found.push(match[1]);
    }
  }
  return found;
}

export function runsTaskCommand(text: string, taskId: string): boolean {
  const id = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `\\bspecpilot\\s+(gate|tdd\\s+(red|green)|mutate(\\s+bug)?|verify|reopen)\\s+${id}(?=$|[\\s;&|)'"])`,
  );
  return commands(text).some((command) => pattern.test(command));
}

function readTranscript(file: string): TranscriptMessage[] {
  return parseTranscript(fs.readFileSync(file, 'utf8'));
}

// Messages of the sessions that ran a command for the task, plus their subagents, deduped.
export function taskMessages(dir: string, taskId: string): TranscriptMessage[] {
  const messages: TranscriptMessage[] = [];
  const sessions = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort();
  for (const name of sessions) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (!runsTaskCommand(text, taskId)) continue;
    messages.push(...parseTranscript(text));
    const subagents = path.join(dir, name.slice(0, -'.jsonl'.length), 'subagents');
    if (!fs.existsSync(subagents)) continue;
    for (const file of fs.readdirSync(subagents).filter((sub) => sub.endsWith('.jsonl')).sort()) {
      messages.push(...readTranscript(path.join(subagents, file)));
    }
  }
  return dedupeMessages(messages);
}

// Claude Code writes one line per content block, each with the whole message usage, so a message.id counts once.
export function dedupeMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.id)) return false;
    seen.add(message.id);
    return true;
  });
}

// From the first transition to the last one, or to now if the task is not done.
export function taskWindow(state: TaskState, now: Date = new Date()): TaskWindow {
  const { history } = state;
  if (history.length === 0) {
    throw new Error(`${state.taskId} has no transitions in its state.json, so it has no window`);
  }
  const inProgress = state.phase !== 'done';
  return {
    start: history[0].at,
    end: inProgress ? now.toISOString() : history[history.length - 1].at,
    inProgress,
  };
}

export function inWindow(messages: TranscriptMessage[], window: TaskWindow): TranscriptMessage[] {
  const start = Date.parse(window.start);
  const end = Date.parse(window.end);
  return messages.filter((message) => {
    const time = Date.parse(message.at);
    return time >= start && time <= end;
  });
}

export function totalTokens(messages: TranscriptMessage[]): Tokens {
  const total = zeroTokens();
  for (const message of messages) {
    for (const type of TOKEN_TYPES) total[type] += message.tokens[type];
  }
  return total;
}

// Shipped with the package (templates/ is in package.json "files"); found the same way from src/ and dist/.
export const DEFAULT_PRICES_FILE: string = path.join(__dirname, '..', 'templates', 'prices.json');

// .specpilot/prices.json replaces the shipped defaults whole.
export function readPrices(projectRoot: string): { prices: Prices; file: string } {
  const own = path.join(projectRoot, '.specpilot', 'prices.json');
  const file = fs.existsSync(own) ? own : DEFAULT_PRICES_FILE;
  let prices: Prices;
  try {
    prices = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`Cannot read ${file}: ${(err as Error).message}`);
  }
  if (!prices || typeof prices.models !== 'object' || !prices.models || typeof prices.usdToEur !== 'number') {
    throw new Error(`Corrupt prices file ${file}`);
  }
  return { prices, file };
}

const round2 = (value: number) => Math.round(value * 100) / 100;

// Summed per model and rounded once, so many small messages do not round to 0.
export function computeCost(
  messages: TranscriptMessage[],
  prices: Prices,
  file: string,
): { usd: number; eur: number } {
  const byModel = new Map<string, TranscriptMessage[]>();
  for (const message of messages) byModel.set(message.model, [...(byModel.get(message.model) ?? []), message]);

  let usd = 0;
  for (const [model, ofModel] of byModel) {
    if (!Object.prototype.hasOwnProperty.call(prices.models, model)) {
      throw new Error(`No price for model ${model} in ${file}`);
    }
    const price = prices.models[model];
    const tokens = totalTokens(ofModel);
    usd += TOKEN_TYPES.reduce((sum, type) => sum + tokens[type] * price[type], 0) / 1_000_000;
  }
  return { usd: round2(usd), eur: round2(usd * prices.usdToEur) };
}

export function latencyMs(messages: TranscriptMessage[]): number {
  if (messages.length === 0) return 0;
  const times = messages.map((message) => Date.parse(message.at));
  return Math.max(...times) - Math.min(...times);
}

export function costReport(
  projectRoot: string,
  taskId: string,
  now: Date = new Date(),
  home: string = os.homedir(),
): CostReport {
  const state = loadState(path.join(projectRoot, 'specs', taskId), taskId);
  const window = taskWindow(state, now);
  const dir = transcriptDir(projectRoot, home);
  if (!fs.existsSync(dir)) throw new Error(`No Claude Code transcripts for this project: missing ${dir}`);

  const messages = inWindow(taskMessages(dir, taskId), window);
  if (messages.length === 0) {
    throw new Error(`${taskId} has no messages in its window (${window.start} to ${window.end})`);
  }
  const { prices, file } = readPrices(projectRoot);
  const { usd, eur } = computeCost(messages, prices, file);
  return {
    taskId,
    inProgress: window.inProgress,
    tokens: totalTokens(messages),
    usd,
    eur,
    latencyMs: latencyMs(messages),
    mode: readModeConfig(projectRoot).mode,
    prices: { file, checked: prices.checked },
  };
}
