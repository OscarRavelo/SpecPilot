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

// "unterminated" ends the tokens at a quote that never closes: nothing after it is reliable.
type ShellToken =
  | { kind: 'word' | 'op'; value: string }
  | { kind: 'redirect'; target: string | null }
  | { kind: 'unterminated' };

// "&&" and "||" split commands just like "&" and "|", so they need no entry of their own.
const OPERATORS = [';', '|', '&', '\n'];

// Where the quote that opens at command[start] closes, or -1 if it never does. Inside double quotes a
// backslash escapes the next character; inside single quotes nothing is special. The tokenizer and
// unsafeSyntax both use it, so they always agree on what is quoted.
function quoteEnd(command: string, start: number): number {
  const quote = command[start];
  for (let i = start + 1; i < command.length; i++) {
    if (quote === '"' && command[i] === '\\') i++;
    else if (command[i] === quote) return i;
  }
  return -1;
}

// After ">&", a number or "-" duplicates or closes a descriptor; any other word is a file.
const isDescriptor = (word: string) => /^\d+$/.test(word) || word === '-';

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
        const end = quoteEnd(command, i);
        if (end === -1) return value; // the main loop stops at the unterminated quote
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
      const end = quoteEnd(command, i);
      if (end === -1) {
        tokens.push({ kind: 'unterminated' });
        return tokens;
      }
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
        const word = readWord(); // ">&2" duplicates a descriptor, but ">&out.txt" writes out.txt
        tokens.push({ kind: 'redirect', target: isDescriptor(word) ? null : word });
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

// Options known to be read-only. A word starting with "-" must match one of them; positional
// arguments are free. Short flags may be combined (-rn) and a short value may be attached (-n5).
// A value given as the next word may not start with "-", so it can never hide another option.
interface Options {
  flags?: string; // short flags without a value
  values?: string; // short options that take a value, attached (-n5) or as the next word (-n 5)
  attached?: string; // short options whose value must be attached (-U5), because it is optional
  long?: string[]; // long options without a value (find primaries such as -print count as long)
  longValues?: string[]; // long options that take a value, as "--glob G" or "--glob=G"
  equalsOnly?: string[]; // long options whose value is optional, so it must follow "=" (--pretty=oneline)
  bare?: string[]; // long options the program could read the next word as a value of (tsc --noEmit false)
  numeric?: boolean; // -N, as in head -20 or git log -5
  dashDashChecked?: boolean; // "--" does not end the options, so what follows is checked too
  required?: string;
}

const GIT_HISTORY: Options = {
  flags: 'p',
  values: 'n',
  attached: 'U',
  long: ['--stat', '--shortstat', '--name-only', '--name-status', '--oneline', '--patch', '--cached', '--staged', '--no-color'],
  equalsOnly: ['--format', '--pretty'],
  numeric: true,
};

const JEST: Options = {
  flags: 'i',
  values: 't',
  long: ['--runInBand', '--verbose', '--silent', '--no-coverage', '--json', '--colors', '--ci'],
  longValues: ['--testNamePattern'],
  dashDashChecked: true,
};

// The one table of what tests-agent and code-agent may run in Bash. A null entry takes any arguments.
const BASH_ALLOWLIST: Record<string, Options | null> = {
  cat: { flags: 'n' },
  head: { values: 'nc', numeric: true },
  tail: { values: 'nc', numeric: true },
  ls: { flags: 'laA1Rhtr' },
  wc: { flags: 'lwcm' },
  diff: { flags: 'urqN', attached: 'U', long: ['--brief'] },
  grep: {
    flags: 'nilLcwxrREFvohHsq',
    values: 'eABC',
    long: ['--color=never'],
    longValues: ['--include', '--exclude', '--exclude-dir'],
  },
  rg: {
    flags: 'nilcwFvSu',
    values: 'egtABC',
    long: ['--files', '--no-heading', '--hidden'],
    longValues: ['--glob'],
  },
  find: {
    long: ['-not', '-o', '-a', '-print', '-print0'],
    longValues: ['-name', '-iname', '-path', '-type', '-maxdepth', '-mindepth', '-newer'],
  },
  'git status': { flags: 'sb', values: 'u', long: ['--short', '--porcelain', '--branch'], longValues: ['--untracked-files'] },
  'git diff': GIT_HISTORY,
  'git show': GIT_HISTORY,
  'git log': GIT_HISTORY,
  'git blame': { flags: 'w', values: 'L' },
  'git ls-files': { flags: 'mds' },
  'git rev-parse': { long: ['--abbrev-ref', '--show-toplevel', '--short'] },
  'npx jest': JEST,
  // "--" is checked as an option, so it can never hide options after it.
  'npx tsc': {
    values: 'p',
    long: ['--noEmit'],
    longValues: ['--project', '--pretty'],
    bare: ['--noEmit'],
    required: '--noEmit',
    dashDashChecked: true,
  },
  echo: null,
  printf: null,
  pwd: null,
  true: null,
  which: null,
};

// The specpilot commands each agent may run, through npx or node dist/cli.js. "<task>" stands for a
// task id and "<AC-n>" for an acceptance criterion; anything else must match word for word.
const SPECPILOT_COMMANDS: Record<string, string[]> = {
  'tests-agent': ['status', 'tdd red <task>'],
  'code-agent': ['status', 'tdd green <task>', 'mutate <task>', 'mutate bug <task> <AC-n>'],
};
const specpilotCommands = (agentType: string) => SPECPILOT_COMMANDS[agentType] ?? ['status'];

// "bug" is not a task id: "mutate bug" without a task must not read as mutate on a task called bug.
const isTaskId = (word: string) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(word) && word !== 'bug';

function matchesCommand(args: string[], pattern: string): boolean {
  const words = pattern.split(' ');
  return (
    words.length === args.length &&
    words.every((word, k) => {
      if (word === '<task>') return isTaskId(args[k]);
      if (word === '<AC-n>') return /^AC-\d+$/.test(args[k]);
      return word === args[k];
    })
  );
}

function bashAllowed(agentType: string): string {
  const specpilot = specpilotCommands(agentType).map((pattern) => `npx specpilot ${pattern}`);
  return [
    'npm test',
    'npm run typecheck',
    'npm run build',
    'npx jest',
    'npx tsc --noEmit',
    ...specpilot,
    'git status/diff/show/log/blame/ls-files/rev-parse',
    'cat, head, tail, ls, wc, diff, grep, rg, find, echo, printf, pwd, true, which.',
  ].join(', ');
}

function optionProblem(name: string, options: Options, args: string[]): string | null {
  // The value of "-e P" or "--glob G" is the next word, which may not be another option.
  const valueProblem = (option: string, value: string | undefined): string | null => {
    if (value === undefined) return `${name} option ${option} needs a value`;
    if (value.startsWith('-')) return `${name} option ${option} cannot take ${value} as its value`;
    return null;
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--' && !options.dashDashChecked) break;
    if (!arg.startsWith('-') || arg === '-') continue;
    const unknown = `${name} option ${arg} is not on the allowlist`;

    const [optionName] = arg.split('=', 1);
    if (options.long?.includes(arg)) {
      const next = args[i + 1];
      if (options.bare?.includes(arg) && next !== undefined && !next.startsWith('-')) {
        return `${name} option ${arg} takes no value (${next})`;
      }
      continue;
    }
    if (options.equalsOnly?.includes(optionName)) {
      if (!arg.includes('=')) return `${name} option ${arg} needs its value after =, as in ${arg}=value`;
      continue;
    }
    if (options.longValues?.includes(optionName)) {
      if (!arg.includes('=')) {
        const problem = valueProblem(arg, args[i + 1]);
        if (problem !== null) return problem;
        i++;
      }
      continue;
    }
    if (options.numeric && /^-\d+$/.test(arg)) continue;
    if (arg.startsWith('--')) return unknown;

    for (let j = 1; j < arg.length; j++) {
      const letter = arg[j];
      if (options.flags?.includes(letter)) continue;
      if (options.attached?.includes(letter)) {
        if (j === arg.length - 1) return `${name} option -${letter} needs its value attached, as in -${letter}5`;
        break;
      }
      if (!options.values?.includes(letter)) return unknown;
      if (j === arg.length - 1) {
        const problem = valueProblem(`-${letter}`, args[i + 1]);
        if (problem !== null) return problem;
        i++; // the value is the next argument
      }
      break;
    }
  }
  if (options.required && !args.includes(options.required)) return `${name} needs ${options.required}`;
  return null;
}

function commandProblem(argv: string[], agentType: string): string | null {
  const [program, ...args] = argv;
  if (['eval', 'exec', 'source', '.'].includes(program)) return `${program} runs a command the hook cannot check`;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) return `the variable prefix ${program} can change what a program runs`;
  if (program === 'cd') return 'cd changes the folder the hook checks paths against';

  const cli = (program === 'npx' && args[0] === 'specpilot') || (program === 'node' && args[0] === 'dist/cli.js');
  if (cli) {
    const subcommand = args.slice(1);
    if (specpilotCommands(agentType).some((pattern) => matchesCommand(subcommand, pattern))) return null;
    return `${agentType} may not run specpilot ${subcommand.join(' ')}`.trimEnd();
  }

  if (program === 'npm') {
    if (args[0] === 'test' && args.length === 1) return null;
    if (args[0] === 'test' && args[1] === '--') return optionProblem('npm test --', JEST, args.slice(2));
    if (args[0] === 'run' && ['typecheck', 'build'].includes(args[1]) && args.length === 2) return null;
    return `npm ${args.join(' ')} is not on the allowlist`;
  }
  if ((program === 'git' || program === 'npx') && args[0]?.startsWith('-')) {
    return `${program} options before the command are not allowed (${args[0]})`;
  }

  const name = ['git', 'npx', 'node'].includes(program) && args.length > 0 ? `${program} ${args[0]}` : program;
  if (!(name in BASH_ALLOWLIST)) return `${name} is not on the allowlist`;
  const options = BASH_ALLOWLIST[name];
  return options === null ? null : optionProblem(name, options, name === program ? args : args.slice(1));
}

// Expansions that run or produce text the tokenizer cannot see; they work unquoted and inside double quotes.
function expansion(c: string, next: string): string | null {
  if (c === '`') return 'backticks';
  if (c !== '$') return null;
  if (next === '(') return '$(...)';
  if (next === "'" || next === '"') return `${c}${next}...${next} quoting`;
  if (/[A-Za-z0-9_{@*#?$!-]/.test(next)) return 'variable expansion';
  return null;
}

// Shell syntax that runs or writes something the tokenizer cannot see. Inside single quotes nothing
// expands. Quotes end where the tokenizer ends them (quoteEnd), and a backslash inside double quotes
// is blocked outright, so the two can never disagree about what is quoted. An unquoted backslash is
// blocked too (a backslash-newline joins words, so "\<newline>-delete" hides an option), and so is an
// unquoted glob character, which the shell expands into words the hook never sees.
function unsafeSyntax(command: string): string | null {
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1] ?? '';
    if (c === "'" || c === '"') {
      const end = quoteEnd(command, i);
      if (end === -1) return 'unterminated quote';
      for (let j = i + 1; c === '"' && j < end; j++) {
        if (command[j] === '\\') return 'a backslash inside double quotes';
        const inside = expansion(command[j], command[j + 1]);
        if (inside !== null) return inside;
      }
      i = end;
      continue;
    }
    if (c === '\\') return 'a backslash outside quotes';
    const unquoted = expansion(c, next);
    if (unquoted !== null) return unquoted;
    if (c === '*' || c === '?' || c === '[') return 'an unquoted glob character';
    if (c === '<' && next === '<') return 'heredoc';
    if ((c === '<' || c === '>') && next === '(') return 'process substitution';
    if (c === '{') return 'brace expansion';
  }
  return null;
}

const isDevNull = (target: string | null) => target === null || target === '/dev/null';

// tests-agent and code-agent write files only with Edit/Write: a Bash command is allowed only if every
// simple command in it is on the allowlist and every redirection goes to /dev/null or a descriptor.
// Anything the hook cannot classify is blocked.
export function bashVerdict(command: string, agentType = 'this agent'): HookDecision {
  const blocked = (reason: string) =>
    deny(
      `${agentType} may not run this command from Bash (${reason}). Only allowlisted read-only commands may run; ` +
        `write files with Edit or Write. Allowed in Bash: ${bashAllowed(agentType)}`,
    );

  const syntax = unsafeSyntax(command);
  if (syntax !== null) return blocked(syntax);

  let argv: string[] = [];
  const endCommand = (): string | null => {
    const problem = argv.length > 0 ? commandProblem(argv, agentType) : null;
    argv = [];
    return problem;
  };

  for (const token of tokenize(command)) {
    if (token.kind === 'word') argv.push(token.value);
    else if (token.kind === 'unterminated') return blocked('unterminated quote');
    else if (token.kind === 'redirect' && !isDevNull(token.target)) return blocked(`a redirection writes to ${token.target}`);
    else if (token.kind === 'op') {
      const problem = endCommand();
      if (problem !== null) return blocked(problem);
    }
  }
  const problem = endCommand();
  return problem === null ? allow() : blocked(problem);
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
        : `${task.taskId} is in verify, so the task is not done: run specpilot verify ${task.taskId}.`,
    )
    .join(' ');
}

// With roles, a file must be allowed both by the agent's role and by the phase; the role is checked first.
export function checkToolUse(input: ToolUse, root: string, taskId?: string, roles = false): HookDecision {
  let targets: string[];
  if (input.tool_name === 'Bash') {
    const command = input.tool_input.command;
    if (roles && typeof command === 'string' && (input.agent_type === 'tests-agent' || input.agent_type === 'code-agent')) {
      const verdict = bashVerdict(command, input.agent_type);
      if (!verdict.allow) return verdict;
    }
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
