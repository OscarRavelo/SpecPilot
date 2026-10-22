import path from 'path';

export type InitActionKind = 'created' | 'updated' | 'kept';

// file: path relative to the project root, with forward slashes, e.g. '.claude/settings.json'.
export interface InitAction {
  kind: InitActionKind;
  file: string;
}

export interface InitResult {
  actions: InitAction[];
  warnings: string[];
}

// Shipped with the package, found the same way from src/ and dist/.
export const TEMPLATES_DIR: string = path.join(__dirname, '..', 'templates');

// The installed files, relative to templates/ and to the project root, in this order.
export const INSTALLED_FILES: string[] = [
  '.claude/settings.json',
  '.claude/skills/sp-grill/SKILL.md',
  '.claude/agents/grill-auditor.md',
];

// Pure: returns the merged settings and whether anything was added.
export function mergeSettings(
  existing: unknown,
  template: Record<string, unknown>,
): { settings: Record<string, unknown>; added: boolean } {
  void existing;
  void template;
  return { settings: {}, added: false };
}

// Checks package.json and settings.json before any write. Returns the actions and warnings.
export function initProject(projectRoot: string, templatesDir: string = TEMPLATES_DIR): InitResult {
  void projectRoot;
  void templatesDir;
  return { actions: [], warnings: [] };
}
