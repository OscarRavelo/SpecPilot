import fs from 'fs';
import os from 'os';
import path from 'path';
import { INSTALLED_FILES, TEMPLATES_DIR, initProject, mergeSettings } from '../src/init';
import type { InitAction } from '../src/init';
import { INSTALL } from '../src/mutation';

const REPO_TEMPLATES = path.join(__dirname, '..', 'templates');
const SETTINGS = '.claude/settings.json';
const SKILL = '.claude/skills/sp-grill/SKILL.md';
const AUDITOR = '.claude/agents/grill-auditor.md';

type Hook = { type: string; command: string };
type Group = { matcher?: string; hooks: Hook[] };
type Settings = { hooks: { PreToolUse: Group[]; Stop: Group[] } };

const template = (file: string): Buffer => fs.readFileSync(path.join(REPO_TEMPLATES, file));
const templateSettings = (): Settings & Record<string, unknown> => JSON.parse(template(SETTINGS).toString('utf8'));

const LINT: Group = { matcher: 'Write', hooks: [{ type: 'command', command: './lint.sh' }] };
const PERMISSIONS = { allow: ['Bash(ls)'] };
const ALL_PACKAGES = {
  name: 'sample',
  version: '1.0.0',
  devDependencies: {
    jest: '^30.0.0',
    '@stryker-mutator/core': '10.0.0',
    '@stryker-mutator/jest-runner': '10.0.0',
    '@stryker-mutator/typescript-checker': '10.0.0',
    specpilot: '^0.1.0',
  },
};

const byFile = (actions: InitAction[]) => [...actions].sort((a, b) => a.file.localeCompare(b.file));

function thrown(fn: () => unknown): Error | undefined {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  return undefined;
}

describe('mergeSettings', () => {
  test('AC-4: keeps the permissions and the existing group first, and appends the template groups', () => {
    const tmpl = templateSettings();
    const existing = { permissions: PERMISSIONS, hooks: { PreToolUse: [LINT] } };
    const copy = JSON.parse(JSON.stringify(existing));
    expect(mergeSettings(existing, tmpl)).toEqual({
      settings: {
        permissions: PERMISSIONS,
        hooks: { PreToolUse: [LINT, ...tmpl.hooks.PreToolUse], Stop: [...tmpl.hooks.Stop] },
      },
      added: true,
    });
    // Pure: the input is not changed.
    expect(existing).toEqual(copy);
  });

  test('AC-4: keeps the key order of the existing settings', () => {
    const tmpl = templateSettings();
    const { settings } = mergeSettings({ permissions: PERMISSIONS, hooks: { PreToolUse: [LINT] }, env: { A: '1' } }, tmpl);
    expect(Object.keys(settings)).toEqual(['permissions', 'hooks', 'env']);
    expect(Object.keys(settings.hooks as object)).toEqual(['PreToolUse', 'Stop']);
  });

  test('AC-4: settings with no hooks gain both template groups', () => {
    const tmpl = templateSettings();
    expect(mergeSettings({ permissions: PERMISSIONS }, tmpl)).toEqual({
      settings: { permissions: PERMISSIONS, hooks: { PreToolUse: [...tmpl.hooks.PreToolUse], Stop: [...tmpl.hooks.Stop] } },
      added: true,
    });
  });

  test('AC-4: a PreToolUse group running "npx specpilot hook pre-tool-use --roles" means only Stop is added', () => {
    const tmpl = templateSettings();
    const roles: Group = { matcher: 'Bash', hooks: [{ type: 'command', command: 'npx specpilot hook pre-tool-use --roles' }] };
    expect(mergeSettings({ hooks: { PreToolUse: [roles] } }, tmpl)).toEqual({
      settings: { hooks: { PreToolUse: [roles], Stop: [...tmpl.hooks.Stop] } },
      added: true,
    });
  });

  test('AC-4: an existing SpecPilot stop hook means only the PreToolUse group is added', () => {
    const tmpl = templateSettings();
    const stop: Group = { hooks: [{ type: 'command', command: 'node dist/cli.js; npx specpilot hook stop' }] };
    expect(mergeSettings({ hooks: { PreToolUse: [LINT], Stop: [stop] } }, tmpl)).toEqual({
      settings: { hooks: { PreToolUse: [LINT, ...tmpl.hooks.PreToolUse], Stop: [stop] } },
      added: true,
    });
  });

  test('AC-4: settings that already have both SpecPilot hooks are returned unchanged with added false', () => {
    const tmpl = templateSettings();
    const existing = {
      permissions: PERMISSIONS,
      hooks: {
        PreToolUse: [LINT, { matcher: 'Bash', hooks: [{ type: 'command', command: 'npx specpilot hook pre-tool-use' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'npx specpilot hook stop' }] }],
      },
    };
    expect(mergeSettings(existing, tmpl)).toEqual({ settings: existing, added: false });
  });

  test('AC-4: merging the template into itself adds nothing', () => {
    const tmpl = templateSettings();
    const merged = mergeSettings(tmpl, tmpl);
    expect(merged.added).toBe(false);
    expect(merged.settings).toEqual(tmpl);
    // Merging twice is the same as merging once.
    const once = mergeSettings({ permissions: PERMISSIONS, hooks: { PreToolUse: [LINT] } }, tmpl).settings;
    expect(once.hooks).toBeDefined();
    expect(mergeSettings(once, tmpl)).toEqual({ settings: once, added: false });
  });
});

describe('initProject', () => {
  let project: string;
  const at = (file: string) => path.join(project, file);
  const exists = (file: string) => fs.existsSync(at(file));
  const read = (file: string) => fs.readFileSync(at(file));
  const write = (file: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(at(file)), { recursive: true });
    fs.writeFileSync(at(file), content);
  };
  const writePackage = (pkg: unknown) => write('package.json', JSON.stringify(pkg, null, 2) + '\n');

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-init-'));
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  test('AC-1: creates the INSTALLED_FILES from the default TEMPLATES_DIR and reports each one', () => {
    expect(INSTALLED_FILES).toEqual([SETTINGS, SKILL, AUDITOR]);
    expect(path.resolve(TEMPLATES_DIR)).toBe(path.resolve(REPO_TEMPLATES));
    writePackage(ALL_PACKAGES);
    const result = initProject(project);
    expect(byFile(result.actions)).toEqual(
      byFile([
        { kind: 'created', file: SETTINGS },
        { kind: 'created', file: SKILL },
        { kind: 'created', file: AUDITOR },
      ]),
    );
    expect(result.warnings).toEqual([]);
    for (const file of [SETTINGS, SKILL, AUDITOR]) {
      expect({ file, equal: exists(file) && read(file).equals(template(file)) }).toEqual({ file, equal: true });
    }
  });

  test('AC-4: merges an existing settings.json, written with 2 spaces and a final newline', () => {
    writePackage(ALL_PACKAGES);
    write(SETTINGS, JSON.stringify({ permissions: PERMISSIONS, hooks: { PreToolUse: [LINT] } }));
    const result = initProject(project, REPO_TEMPLATES);
    expect(result.actions).toContainEqual({ kind: 'updated', file: SETTINGS });
    const tmpl = templateSettings();
    const expected = {
      permissions: PERMISSIONS,
      hooks: { PreToolUse: [LINT, ...tmpl.hooks.PreToolUse], Stop: [...tmpl.hooks.Stop] },
    };
    expect(read(SETTINGS).toString('utf8')).toBe(JSON.stringify(expected, null, 2) + '\n');
  });

  test('AC-4: a settings.json with both SpecPilot hooks keeps every byte and gets no action', () => {
    writePackage(ALL_PACKAGES);
    const text = JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'npx specpilot hook pre-tool-use --roles' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'npx specpilot hook stop' }] }],
      },
    });
    write(SETTINGS, text);
    const result = initProject(project, REPO_TEMPLATES);
    expect(read(SETTINGS).toString('utf8')).toBe(text);
    expect(byFile(result.actions)).toEqual(
      byFile([
        { kind: 'created', file: SKILL },
        { kind: 'created', file: AUDITOR },
      ]),
    );
  });

  test('AC-3: a second run returns no actions', () => {
    writePackage(ALL_PACKAGES);
    expect(initProject(project, REPO_TEMPLATES).actions).toHaveLength(3);
    expect(initProject(project, REPO_TEMPLATES)).toEqual({ actions: [], warnings: [] });
  });

  test.each([
    ['not valid JSON', '{ "hooks": '],
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '42'],
    ['hooks is a string', '{"hooks": "x"}'],
    ['hooks is an array', '{"hooks": []}'],
    ['hooks.PreToolUse is not an array', '{"hooks": {"PreToolUse": {}}}'],
    ['hooks.Stop is not an array', '{"hooks": {"Stop": "x"}}'],
  ])('AC-5: a settings.json that is %s throws an Error naming the file, before any write', (_shape, text) => {
    writePackage(ALL_PACKAGES);
    write(SETTINGS, text);
    const error = thrown(() => initProject(project, REPO_TEMPLATES));
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('.claude/settings.json');
    expect(read(SETTINGS).toString('utf8')).toBe(text);
    expect(exists(SKILL)).toBe(false);
    expect(exists(AUDITOR)).toBe(false);
  });

  test('AC-6: a changed grill-auditor.md is kept and reported, the other 2 are created', () => {
    writePackage(ALL_PACKAGES);
    write(AUDITOR, 'my own auditor\n');
    const result = initProject(project, REPO_TEMPLATES);
    expect(byFile(result.actions)).toEqual(
      byFile([
        { kind: 'created', file: SETTINGS },
        { kind: 'created', file: SKILL },
        { kind: 'kept', file: AUDITOR },
      ]),
    );
    expect(read(AUDITOR).toString('utf8')).toBe('my own auditor\n');
  });

  test('AC-6: a grill-auditor.md equal to its template gets no action', () => {
    writePackage(ALL_PACKAGES);
    write(AUDITOR, template(AUDITOR));
    const result = initProject(project, REPO_TEMPLATES);
    expect(byFile(result.actions)).toEqual(
      byFile([
        { kind: 'created', file: SETTINGS },
        { kind: 'created', file: SKILL },
      ]),
    );
  });

  test('AC-7: a missing package.json throws an Error naming package.json and creates nothing', () => {
    const error = thrown(() => initProject(project, REPO_TEMPLATES));
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('package.json');
    expect(fs.readdirSync(project)).toEqual([]);
  });

  test.each([
    ['not valid JSON', '{ "name": '],
    ['null', 'null'],
    ['an array', '[]'],
  ])('AC-7: a package.json that is %s throws an Error naming package.json', (_shape, text) => {
    write('package.json', text);
    const error = thrown(() => initProject(project, REPO_TEMPLATES));
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain('package.json');
    expect(fs.readdirSync(project)).toEqual(['package.json']);
  });

  describe('AC-8: warnings', () => {
    const without = (name: string) => {
      const devDependencies: Record<string, string> = { ...ALL_PACKAGES.devDependencies };
      delete devDependencies[name];
      return { ...ALL_PACKAGES, devDependencies };
    };

    test('AC-8: without jest there is one warning, naming jest', () => {
      writePackage(without('jest'));
      const { warnings } = initProject(project, REPO_TEMPLATES);
      expect(warnings).toEqual([expect.stringContaining('jest')]);
    });

    test('AC-8: without a Stryker package there is one warning with the INSTALL command', () => {
      writePackage(without('@stryker-mutator/typescript-checker'));
      const { warnings } = initProject(project, REPO_TEMPLATES);
      expect(INSTALL).toBe('npm i -D @stryker-mutator/core @stryker-mutator/jest-runner @stryker-mutator/typescript-checker');
      expect(warnings).toEqual([expect.stringContaining(INSTALL)]);
    });

    test('AC-8: without specpilot there is one warning about npx --no specpilot', () => {
      writePackage(without('specpilot'));
      const { warnings } = initProject(project, REPO_TEMPLATES);
      expect(warnings).toEqual([expect.stringContaining('npx --no specpilot')]);
    });

    test('AC-8: with no packages there are 3 warnings, and the files are still installed', () => {
      writePackage({ name: 'sample', version: '1.0.0' });
      const result = initProject(project, REPO_TEMPLATES);
      expect(result.warnings).toHaveLength(3);
      expect(result.actions).toHaveLength(3);
    });

    test('AC-8: packages in dependencies count as much as in devDependencies', () => {
      writePackage({ name: 'sample', version: '1.0.0', dependencies: ALL_PACKAGES.devDependencies });
      const result = initProject(project, REPO_TEMPLATES);
      expect(result.warnings).toEqual([]);
      expect(result.actions).toHaveLength(3);
    });
  });
});
