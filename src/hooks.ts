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
    if (name === 'state.json') return 'state';
    if (name === 'audit.md') return 'audit';
  }
  if (TEST_FILE.test(name) || parts.slice(0, -1).some((part) => TEST_DIRS.includes(part))) return 'test';
  if (SOURCE_FILE.test(name)) return 'source';
  return 'other';
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

export function checkToolUse(input: ToolUse, root: string, taskId?: string): HookDecision {
  if (!EDIT_TOOLS.includes(input.tool_name)) return allow();
  const target = editedPath(input);
  if (target === null) return allow();

  const realRoot = realPath(path.resolve(root));
  const relative = path.relative(realRoot, realPath(path.resolve(root, target)));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return allow();
  const file = relative.split(path.sep).join('/');
  const kind = classifyPath(file);

  if (kind === 'state') {
    return deny(`${file} is managed by the CLI; move phases with specpilot gate or specpilot reopen.`);
  }
  if (kind === 'audit') {
    return input.agent_type === 'grill-auditor'
      ? allow()
      : deny(`${file} is written only by the grill-auditor subagent.`);
  }
  if (kind === 'other') return allow();

  const specsDir = path.join(root, 'specs');
  let tasks: { taskId: string; phase: Phase }[];
  try {
    if (taskId) {
      if (!fs.existsSync(path.join(specsDir, taskId))) {
        return deny(`SPECPILOT_TASK=${taskId} is not a task in specs/.`);
      }
      tasks = [loadState(path.join(specsDir, taskId), taskId)];
    } else {
      tasks = listTasks(specsDir).map((id) => loadState(path.join(specsDir, id), id));
    }
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
