import fs from 'fs';
import path from 'path';
import { listTasks, loadState } from './state';
import type { Phase } from './state';

export type FileKind = 'state' | 'audit' | 'test' | 'source' | 'other';

export interface ToolUse {
  tool_name: string;
  tool_input: Record<string, unknown>;
  agent_type?: string;
}

export interface HookDecision {
  allow: boolean;
  reason?: string;
}

const EDIT_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];
const TEST_DIRS = ['test', 'tests', '__tests__'];
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SOURCE_FILE = /\.[cm]?[jt]sx?$/;
// Files in specs/<task>/ that only the CLI writes; equivalents.md is approved by the human, never by an agent.
const STATE_FILES = ['state.json', 'red.json', 'green.json', 'mutation.json', 'equivalents.md'];

// Red is for writing tests, green and mutation for changing code; every other phase is read-only.
const EDITABLE: Record<Phase, FileKind[]> = {
  research: [],
  grill: [],
  plan: [],
  red: ['test'],
  green: ['source'],
  mutation: ['source'],
  verify: [],
  done: ['test', 'source'],
};

const allow = (): HookDecision => ({ allow: true });
const deny = (reason: string): HookDecision => ({ allow: false, reason: `Blocked by SpecPilot: ${reason}` });

// Paths are relative to the project root, with forward slashes.
export function classifyPath(relPath: string): FileKind {
  const parts = relPath.split('/');
  const name = parts[parts.length - 1];
  if (parts.length === 3 && parts[0] === 'specs') {
    if (STATE_FILES.includes(name)) return 'state';
    if (name === 'audit.md') return 'audit';
  }
  if (TEST_FILE.test(name) || parts.slice(0, -1).some((part) => TEST_DIRS.includes(part))) return 'test';
  if (SOURCE_FILE.test(name)) return 'source';
  return 'other';
}

type ShellToken = { kind: 'word' | 'op'; value: string } | { kind: 'redirect'; target: string | null };

// "&&" and "||" split commands just like "&" and "|", so they need no entry of their own.
const OPERATORS = [';', '|', '&', '\n'];

// A small shell tokenizer: quotes, backslashes, operators, redirections and heredocs.
// It only needs to find the files a command writes, not to run it.
function tokenize(command: string): ShellToken[] {
  const tokens: ShellToken[] = [];
  const heredocs: string[] = [];
  let word = '';
  let quoted = false;
  let i = 0;

  const flush = () => {
    if (word !== '' || quoted) tokens.push({ kind: 'word', value: word });
    word = '';
    quoted = false;
  };
  const readWord = (): string => {
    while (command[i] === ' ' || command[i] === '\t') i++;
    let value = '';
    while (i < command.length && !/[\s;&|<>]/.test(command[i])) {
      const c = command[i];
      if (c === "'" || c === '"') {
        const end = command.indexOf(c, i + 1);
        if (end === -1) return value;
        value += command.slice(i + 1, end);
        i = end + 1;
      } else {
        value += c;
        i++;
      }
    }
    return value;
  };

  while (i < command.length) {
    const c = command[i];
    if (c === '\\') {
      word += command[i + 1] ?? '';
      i += 2;
    } else if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      if (end === -1) return tokens; // unterminated quote: nothing reliable after it
      word += c === '"' ? command.slice(i + 1, end).replace(/\\(["\\$`])/g, '$1') : command.slice(i + 1, end);
      quoted = true;
      i = end + 1;
    } else if (c === '>' || (c === '&' && command[i + 1] === '>')) {
      if (c === '&') i++;
      else if (/^\d+$/.test(word)) word = ''; // "2>" redirects a file descriptor, the 2 is not an argument
      flush();
      i += command[i + 1] === '>' ? 2 : 1;
      if (command[i] === '&') {
        i++;
        readWord(); // ">&2" duplicates a descriptor, no file is written
        tokens.push({ kind: 'redirect', target: null });
      } else {
        tokens.push({ kind: 'redirect', target: readWord() });
      }
    } else if (c === '<') {
      flush();
      if (command[i + 1] === '<') {
        i += command[i + 2] === '-' ? 3 : 2;
        heredocs.push(readWord());
      } else {
        i++;
        readWord();
      }
    } else if (c === '\n' && heredocs.length > 0) {
      flush();
      tokens.push({ kind: 'op', value: '\n' });
      // Skip heredoc bodies: their text is input, not commands.
      const lines = command.slice(i + 1).split('\n');
      let consumed = 0;
      for (const delimiter of heredocs) {
        while (consumed < lines.length && lines[consumed].trim() !== delimiter) consumed++;
        consumed++;
      }
      heredocs.length = 0;
      i += 1 + lines.slice(0, consumed).join('\n').length + 1;
    } else if (OPERATORS.some((op) => command.startsWith(op, i))) {
      flush();
      const op = OPERATORS.find((candidate) => command.startsWith(candidate, i)) as string;
      tokens.push({ kind: 'op', value: op });
      i += op.length;
    } else if (c === ' ' || c === '\t') {
      flush();
      i++;
    } else {
      word += c;
      i++;
    }
  }
  flush();
  return tokens;
}

const positional = (args: string[]) => args.filter((arg) => !arg.startsWith('-') && arg !== '');

// Arguments that a command reads as the value of an option, e.g. "-e <script>".
function withoutOptionValues(args: string[], options: string[]): string[] {
  return args.filter((_, index) => index === 0 || !options.includes(args[index - 1]));
}

function commandTargets(argv: string[], root?: string): string[] {
  const program = path.basename(argv[0]);
  const args = argv.slice(1);

  if (program === 'tee' || program === 'rm' || program === 'touch') return positional(args);
  if (program === 'truncate') return positional(withoutOptionValues(args, ['-s', '--size']));
  if (program === 'dd') return args.filter((arg) => arg.startsWith('of=')).map((arg) => arg.slice(3));

  if (program === 'sed' || program === 'perl') {
    const inPlace = args.some((arg) => arg === '--in-place' || /^-[a-zA-Z]*i/.test(arg));
    if (!inPlace) return [];
    const scriptOptions = program === 'sed' ? ['-e', '-f', '--expression', '--file'] : ['-e', '-E'];
    const files = positional(withoutOptionValues(args, scriptOptions));
    const hasScriptOption = args.some((arg) => scriptOptions.includes(arg) || /^-[a-zA-Z]*e$/.test(arg));
    return hasScriptOption ? files : files.slice(1);
  }

  if (program === 'cp' || program === 'mv') {
    const paths = positional(args);
    if (paths.length < 2) return [];
    const dest = paths[paths.length - 1];
    const sources = paths.slice(0, -1);
    const intoFolder =
      dest.endsWith('/') || (root !== undefined && fs.existsSync(path.resolve(root, dest)) && fs.statSync(path.resolve(root, dest)).isDirectory());
    const written = intoFolder ? sources.map((source) => path.posix.join(dest, path.basename(source))) : [dest];
    return program === 'mv' ? [...sources, ...written] : written;
  }
  return [];
}

// Files a shell command writes, as written in the command (relative paths stay relative).
export function bashTargets(command: string, root?: string): string[] {
  const targets: string[] = [];
  let argv: string[] = [];
  const endCommand = () => {
    while (argv.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[0])) argv.shift();
    if (argv.length > 0) targets.push(...commandTargets(argv, root));
    argv = [];
  };

  for (const token of tokenize(command)) {
    if (token.kind === 'word') argv.push(token.value);
    else if (token.kind === 'op') endCommand();
    else if (token.kind === 'redirect' && token.target) targets.push(token.target);
  }
  endCommand();
  return targets;
}

function editedPath(input: ToolUse): string | null {
  const file = input.tool_input.file_path ?? input.tool_input.notebook_path;
  return typeof file === 'string' ? file : null;
}

// Resolves symlinks (e.g. /var → /private/var on macOS) even for a file that does not exist yet.
function realPath(file: string): string {
  const missing: string[] = [];
  let dir = file;
  while (!fs.existsSync(dir)) {
    missing.unshift(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) return file;
    dir = parent;
  }
  return path.join(fs.realpathSync(dir), ...missing);
}

function phaseRule(taskId: string, phase: Phase, kind: FileKind, file: string): string | null {
  if (EDITABLE[phase].includes(kind)) return null;
  const rule =
    kind === 'test'
      ? `tests can be edited only in red (go back with: specpilot reopen ${taskId} red)`
      : 'source code can be edited only in green or mutation';
  return `${taskId} is in ${phase}, so ${file} cannot be edited: ${rule}.`;
}

// The tasks the hooks look at: the one chosen with SPECPILOT_TASK, or every task in specs/.
// Throws on a missing chosen task or a corrupt state.json.
export function watchedTasks(root: string, taskId?: string): { taskId: string; phase: Phase }[] {
  const specsDir = path.join(root, 'specs');
  if (!taskId) return listTasks(specsDir).map((id) => loadState(path.join(specsDir, id), id));
  if (!fs.existsSync(path.join(specsDir, taskId))) {
    throw new Error(`SPECPILOT_TASK=${taskId} is not a task in specs/.`);
  }
  return [loadState(path.join(specsDir, taskId), taskId)];
}

// Tests belong to tests-agent and source code to code-agent; each of them may edit nothing else.
function roleRule(agentType: string | undefined, kind: FileKind, file: string): string | null {
  if (kind === 'test') return agentType === 'tests-agent' ? null : `only tests-agent may edit tests (${file}).`;
  if (kind === 'source') return agentType === 'code-agent' ? null : `only code-agent may edit source code (${file}).`;
  if (agentType === 'tests-agent') return `tests-agent may only edit tests, and ${file} is not a test.`;
  if (agentType === 'code-agent') return `code-agent may only edit source code, and ${file} is not source code.`;
  return null;
}

function checkFile(target: string, root: string, agentType: string | undefined, taskId?: string, roles = false): HookDecision {
  const realRoot = realPath(path.resolve(root));
  const relative = path.relative(realRoot, realPath(path.resolve(root, target)));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return allow();
  const file = relative.split(path.sep).join('/');
  const kind = classifyPath(file);

  if (kind === 'state') {
    if (file.endsWith('/equivalents.md')) {
      return deny(`${file} is written by specpilot mutate, and only the human approves equivalent mutants in it.`);
    }
    return deny(`${file} is written only by the specpilot CLI (specpilot tdd, specpilot mutate, specpilot gate, specpilot reopen).`);
  }
  if (kind === 'audit') {
    return agentType === 'grill-auditor' ? allow() : deny(`${file} is written only by the grill-auditor subagent.`);
  }
  if (roles) {
    const reason = roleRule(agentType, kind, file);
    if (reason !== null) return deny(reason);
  }
  if (kind === 'other') return allow();

  let tasks: { taskId: string; phase: Phase }[];
  try {
    tasks = watchedTasks(root, taskId);
  } catch (err) {
    return deny((err as Error).message);
  }

  const active = tasks.filter((task) => task.phase !== 'done');
  for (const task of active) {
    const reason = phaseRule(task.taskId, task.phase, kind, file);
    if (reason === null) continue;
    const hint = active.length > 1 ? ' Several tasks are active; set SPECPILOT_TASK to the one you are working on.' : '';
    return deny(reason + hint);
  }
  return allow();
}

// A task in mutation or verify is not done yet. Blocking the stop could leave the agent looping, so the
// Stop hook only says what is still missing.
export function stopWarning(root: string, taskId?: string): string | null {
  let tasks: { taskId: string; phase: Phase }[];
  try {
    tasks = watchedTasks(root, taskId);
  } catch (err) {
    return (err as Error).message;
  }
  const waiting = tasks.filter((task) => task.phase === 'mutation' || task.phase === 'verify');
  if (waiting.length === 0) return null;
  return waiting
    .map((task) =>
      task.phase === 'mutation'
        ? `${task.taskId} is in mutation, so the task is not done: run specpilot mutate ${task.taskId} and specpilot gate ${task.taskId}.`
        : `${task.taskId} is in verify, so the task is not done: the verify phase cannot be completed yet (specpilot verify is not implemented).`,
    )
    .join(' ');
}

// With roles, a file must be allowed both by the agent's role and by the phase; the role is checked first.
export function checkToolUse(input: ToolUse, root: string, taskId?: string, roles = false): HookDecision {
  let targets: string[];
  if (input.tool_name === 'Bash') {
    const command = input.tool_input.command;
    targets = typeof command === 'string' ? bashTargets(command, root) : [];
  } else if (EDIT_TOOLS.includes(input.tool_name)) {
    const target = editedPath(input);
    targets = target === null ? [] : [target];
  } else {
    return allow();
  }

  for (const target of targets) {
    const decision = checkFile(target, root, input.agent_type, taskId, roles);
    if (!decision.allow) return decision;
  }
  return allow();
}
