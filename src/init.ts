import fs from 'fs';
import path from 'path';
import { INSTALL } from './mutation';

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

const SETTINGS = '.claude/settings.json';
const STRYKER_PACKAGES = ['@stryker-mutator/core', '@stryker-mutator/jest-runner', '@stryker-mutator/typescript-checker'];

// Each hook event, with the command that marks a SpecPilot hook in it.
const SPECPILOT_HOOKS: [string, string][] = [
  ['PreToolUse', 'specpilot hook pre-tool-use'],
  ['Stop', 'specpilot hook stop'],
];

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCommand(groups: unknown[], marker: string): boolean {
  return groups.some(
    (group) =>
      isObject(group) &&
      Array.isArray(group.hooks) &&
      group.hooks.some((hook) => isObject(hook) && typeof hook.command === 'string' && hook.command.includes(marker)),
  );
}

// Pure: returns the merged settings and whether anything was added.
export function mergeSettings(
  existing: unknown,
  template: Record<string, unknown>,
): { settings: Record<string, unknown>; added: boolean } {
  const settings: JsonObject = isObject(existing) ? existing : {};
  const hooks: JsonObject = isObject(settings.hooks) ? settings.hooks : {};
  const templateHooks: JsonObject = isObject(template.hooks) ? template.hooks : {};
  const merged: JsonObject = { ...hooks };
  let added = false;
  for (const [event, marker] of SPECPILOT_HOOKS) {
    const groups = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const missing = Array.isArray(templateHooks[event]) ? (templateHooks[event] as unknown[]) : [];
    if (hasCommand(groups, marker) || missing.length === 0) continue;
    merged[event] = [...groups, ...missing];
    added = true;
  }
  if (!added) return { settings, added };
  return { settings: { ...settings, hooks: merged }, added };
}

function readPackageList(projectRoot: string): string[] {
  const file = path.join(projectRoot, 'package.json');
  if (!fs.existsSync(file)) {
    throw new Error(`No package.json in ${projectRoot}: specpilot init must run at the project root`);
  }
  let pkg: unknown;
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Corrupt package.json: not valid JSON (${file})`);
  }
  if (!isObject(pkg)) throw new Error(`Corrupt package.json: the root is not an object (${file})`);
  const names = (deps: unknown) => (isObject(deps) ? Object.keys(deps) : []);
  return [...names(pkg.dependencies), ...names(pkg.devDependencies)];
}

// Returns the parsed settings.json, or undefined when there is none.
function readSettings(projectRoot: string): JsonObject | undefined {
  const file = path.join(projectRoot, SETTINGS);
  if (!fs.existsSync(file)) return undefined;
  let settings: unknown;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Corrupt ${SETTINGS}: not valid JSON`);
  }
  if (!isObject(settings)) throw new Error(`Corrupt ${SETTINGS}: the root is not an object`);
  if (settings.hooks !== undefined) {
    if (!isObject(settings.hooks)) throw new Error(`Corrupt ${SETTINGS}: "hooks" is not an object`);
    for (const [event] of SPECPILOT_HOOKS) {
      const groups = settings.hooks[event];
      if (groups !== undefined && !Array.isArray(groups)) {
        throw new Error(`Corrupt ${SETTINGS}: "hooks.${event}" is not an array`);
      }
    }
  }
  return settings;
}

function packageWarnings(packages: string[]): string[] {
  const warnings: string[] = [];
  if (!packages.includes('jest')) warnings.push('jest is not installed: SpecPilot runs your tests with Jest');
  if (STRYKER_PACKAGES.some((name) => !packages.includes(name))) {
    warnings.push(`Stryker is not fully installed: specpilot mutate needs it. Run: ${INSTALL}`);
  }
  if (!packages.includes('specpilot')) {
    warnings.push(
      'specpilot is not installed: the hooks run npx --no specpilot and block every edit until specpilot is installed (npm i -D specpilot)',
    );
  }
  return warnings;
}

// Checks package.json and settings.json before any write. Returns the actions and warnings.
export function initProject(projectRoot: string, templatesDir: string = TEMPLATES_DIR): InitResult {
  // Every check runs before any write, so a broken file changes nothing.
  const warnings = packageWarnings(readPackageList(projectRoot));
  const existingSettings = readSettings(projectRoot);

  const plan: (InitAction & { content?: Buffer | string })[] = [];
  for (const file of INSTALLED_FILES) {
    const source = fs.readFileSync(path.join(templatesDir, file));
    const target = path.join(projectRoot, file);
    if (!fs.existsSync(target)) {
      plan.push({ kind: 'created', file, content: source });
    } else if (file === SETTINGS) {
      const template = JSON.parse(source.toString('utf8')) as JsonObject;
      const { settings, added } = mergeSettings(existingSettings, template);
      if (added) plan.push({ kind: 'updated', file, content: `${JSON.stringify(settings, null, 2)}\n` });
    } else if (!fs.readFileSync(target).equals(source)) {
      plan.push({ kind: 'kept', file });
    }
  }

  for (const { file, content } of plan) {
    if (content === undefined) continue;
    const target = path.join(projectRoot, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  return { actions: plan.map(({ kind, file }) => ({ kind, file })), warnings };
}
