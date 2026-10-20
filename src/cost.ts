import os from 'os';
import type { TaskState } from './state';

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

function zeroTokens(): Tokens {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function transcriptDir(projectRoot: string, home: string = os.homedir()): string {
  void projectRoot;
  void home;
  return '';
}

export function parseTranscript(text: string): TranscriptMessage[] {
  void text;
  return [];
}

export function runsTaskCommand(text: string, taskId: string): boolean {
  void text;
  void taskId;
  return false;
}

// Messages of the sessions that ran a command for the task, plus their subagents, deduped.
export function taskMessages(dir: string, taskId: string): TranscriptMessage[] {
  void dir;
  void taskId;
  return [];
}

export function dedupeMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  void messages;
  return [];
}

export function taskWindow(state: TaskState, now: Date = new Date()): TaskWindow {
  void state;
  void now;
  return { start: '', end: '', inProgress: false };
}

export function inWindow(messages: TranscriptMessage[], window: TaskWindow): TranscriptMessage[] {
  void messages;
  void window;
  return [];
}

export function totalTokens(messages: TranscriptMessage[]): Tokens {
  void messages;
  return zeroTokens();
}

export const DEFAULT_PRICES_FILE: string = '';

export function readPrices(projectRoot: string): { prices: Prices; file: string } {
  void projectRoot;
  return { prices: { checked: '', usdToEur: 0, models: {} }, file: '' };
}

export function computeCost(
  messages: TranscriptMessage[],
  prices: Prices,
  file: string,
): { usd: number; eur: number } {
  void messages;
  void prices;
  void file;
  return { usd: 0, eur: 0 };
}

export function latencyMs(messages: TranscriptMessage[]): number {
  void messages;
  return 0;
}

export function costReport(
  projectRoot: string,
  taskId: string,
  now: Date = new Date(),
  home: string = os.homedir(),
): CostReport {
  void projectRoot;
  void now;
  void home;
  return {
    taskId,
    inProgress: false,
    tokens: zeroTokens(),
    usd: 0,
    eur: 0,
    latencyMs: 0,
    mode: '',
    prices: { file: '', checked: '' },
  };
}
