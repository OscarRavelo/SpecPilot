import type { TASK_TYPES } from './spec';

type TaskType = (typeof TASK_TYPES)[number];

export interface ChecklistItem {
  id: string;
  description: string;
}

const item = (id: string, description: string): ChecklistItem => ({ id, description });

const contract = item('contract', 'route, method, request body and response body');
const validation = item('validation', 'which inputs are accepted or rejected, and the exact rules');
const errors = item('errors', 'error cases, status codes and error bodies');
const data = item('data', 'models, persistence and migrations affected');
const auth = item('auth', 'who may call it; permissions and roles');
const compatibility = item('compatibility', 'existing clients and callers keep working');
const edgeCases = item('edge-cases', 'empty, null, duplicate, missing and boundary values');
const outOfScope = item('out-of-scope', 'what this task must not touch');

// What the grill must pin down, with a cited fact, before a task of each type can be planned.
export const CHECKLISTS: Record<TaskType, ChecklistItem[]> = {
  'new-endpoint': [contract, validation, errors, data, auth, edgeCases, outOfScope],
  'endpoint-fields': [contract, validation, errors, data, auth, compatibility, edgeCases, outOfScope],
  'react-component': [
    item('contract', 'props, events and what the component renders'),
    item('states', 'loading, empty, error and success states'),
    item('data', 'where the data comes from: API, store or props'),
    item('validation', 'which user inputs are accepted or rejected, and the exact rules'),
    item('errors', 'what the user sees when something fails'),
    item('auth', 'who may see or use it; permissions and roles'),
    item('accessibility', 'keyboard use, focus, labels and screen readers'),
    item('compatibility', 'existing screens and callers keep working'),
    item('edge-cases', 'empty, null, long, duplicate and boundary values'),
    outOfScope,
  ],
  'cli-command': [
    item('contract', 'command, arguments and options, stdout, stderr and exit codes'),
    item('files', 'which files it reads and writes, and which must never change'),
    item('errors', 'every failure, with its exit code and message'),
    item('compatibility', 'existing commands, options and files keep working'),
    item('edge-cases', 'missing, empty, corrupt and repeated inputs'),
    outOfScope,
  ],
};

export function checklistFor(type: string): ChecklistItem[] {
  const checklist = CHECKLISTS[type as TaskType];
  if (!checklist) throw new Error(`Unknown task type: ${type}`);
  return checklist;
}
