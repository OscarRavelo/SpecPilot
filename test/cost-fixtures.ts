import fs from 'fs';
import os from 'os';
import path from 'path';

// Small, hand-built Claude Code transcripts for the step-9 tests. Never copied from real logs.

export const MODEL = 'claude-sonnet-5-5';
export const TASK = 'TASK-1';

// A timestamp on 2026-01-01, e.g. at('10:00:00.000').
export const at = (hms: string) => `2026-01-01T${hms}Z`;

export interface AssistantLine {
  id: string;
  at: string;
  sessionId?: string;
  model?: string;
  sidechain?: boolean;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  // When set, the message is a Bash tool call running this command.
  command?: string;
  // When false, the line has no message.usage.
  usage?: boolean;
}

export function assistant(line: AssistantLine): string {
  const content = line.command
    ? [{ type: 'tool_use', id: `toolu_${line.id}`, name: 'Bash', input: { command: line.command, description: 'Run it' } }]
    : [{ type: 'text', text: 'Done.' }];
  const message: Record<string, unknown> = {
    id: line.id,
    type: 'message',
    role: 'assistant',
    model: line.model ?? MODEL,
    content,
  };
  if (line.usage !== false) {
    message.usage = {
      input_tokens: line.input ?? 0,
      output_tokens: line.output ?? 0,
      cache_read_input_tokens: line.cacheRead ?? 0,
      cache_creation_input_tokens: line.cacheWrite ?? 0,
    };
  }
  return JSON.stringify({
    type: 'assistant',
    sessionId: line.sessionId ?? 'sess-a',
    isSidechain: line.sidechain ?? false,
    timestamp: line.at,
    uuid: `uuid-${line.id}-${line.at}`,
    message,
  });
}

// A `!` command typed by the user in Claude Code.
export function bang(command: string, sessionId = 'sess-a', when = at('09:00:00.000')): string {
  return JSON.stringify({
    type: 'user',
    sessionId,
    isSidechain: false,
    timestamp: when,
    uuid: `uuid-bang-${sessionId}-${when}`,
    message: { role: 'user', content: `<bash-input>${command}</bash-input>` },
  });
}

// Main transcripts also hold lines with no `message` key; two handmade ones with minimal fields.
export const permissionModeLine = (sessionId = 'sess-a') =>
  JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId });

export const fileHistorySnapshotLine = (messageId = 'm0') =>
  JSON.stringify({ type: 'file-history-snapshot', messageId, snapshot: {}, isSnapshotUpdate: false });

export const jsonl = (lines: string[]) => `${lines.join('\n')}\n`;

// The transcript folder name computed independently of src/: every non-alphanumeric character becomes '-'.
export const folderName = (projectPath: string) => projectPath.replace(/[^A-Za-z0-9]/g, '-');

export interface Sandbox {
  project: string;
  home: string;
  dir: string;
}

// A temp project and a temp home. Paths are real paths, because a child process sees its cwd resolved.
export function makeSandbox(prefix: string): Sandbox {
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-project-`)));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-home-`)));
  return { project, home, dir: path.join(home, '.claude', 'projects', folderName(project)) };
}

export function removeSandbox(box: Sandbox): void {
  fs.rmSync(box.project, { recursive: true, force: true });
  fs.rmSync(box.home, { recursive: true, force: true });
}

export function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// Writes `<dir>/<relative>` as JSONL.
export function writeTranscript(dir: string, relative: string, lines: string[]): void {
  writeFile(path.join(dir, relative), jsonl(lines));
}

const PHASES = ['research', 'grill', 'plan', 'red', 'green', 'mutation', 'verify', 'done'];

// specs/<taskId>/state.json with one history entry per timestamp; the last entry moves into `phase`.
export function writeState(project: string, taskId: string, phase: string, ats: string[]): void {
  const history = ats.map((when, i) => {
    const last = i === ats.length - 1;
    const to = last ? phase : PHASES[i + 1];
    const from = last ? PHASES[Math.max(PHASES.indexOf(phase) - 1, 0)] : PHASES[i];
    return { from, to, at: when };
  });
  writeFile(
    path.join(project, 'specs', taskId, 'state.json'),
    `${JSON.stringify({ taskId, phase, history }, null, 2)}\n`,
  );
}

export interface PriceFile {
  checked: string;
  usdToEur: number;
  models: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
}

export const flatPrice = (usd: number) => ({ input: usd, output: usd, cacheRead: usd, cacheWrite: usd });

// 1 USD per million tokens of every type, 0.5 EUR per USD.
export const TEST_PRICES: PriceFile = {
  checked: '2026-01-15',
  usdToEur: 0.5,
  models: { [MODEL]: flatPrice(1) },
};

export function writePrices(project: string, prices: PriceFile = TEST_PRICES): string {
  const file = path.join(project, '.specpilot', 'prices.json');
  writeFile(file, `${JSON.stringify(prices, null, 2)}\n`);
  return file;
}

// TASK-1 done, window 10:00:00.000 to 11:00:00.000, test prices, and session sess-a running `specpilot gate TASK-1` as a `!` command.
export function seedDoneTask(box: Sandbox, lines: string[], prices: PriceFile = TEST_PRICES): void {
  writeState(box.project, TASK, 'done', [at('10:00:00.000'), at('11:00:00.000')]);
  writePrices(box.project, prices);
  writeTranscript(box.dir, 'sess-a.jsonl', [bang(`npx specpilot gate ${TASK}`), ...lines]);
}
