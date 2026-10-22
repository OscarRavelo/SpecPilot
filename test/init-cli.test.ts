import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import { INSTALL as MUTATION_INSTALL } from '../src/mutation';

// Runs the compiled CLI, i.e. exactly what gets published (`npm test` builds first).
const REPO = path.join(__dirname, '..');
const BIN = path.join(REPO, 'dist', 'cli.js');
const TEMPLATES = path.join(REPO, 'templates');
const FIXTURES = path.join(__dirname, 'fixtures', 'init');

const SETTINGS = '.claude/settings.json';
const SKILL = '.claude/skills/sp-grill/SKILL.md';
const AUDITOR = '.claude/agents/grill-auditor.md';
const FILES = [SETTINGS, SKILL, AUDITOR];
const INSTALL = 'npm i -D @stryker-mutator/core @stryker-mutator/jest-runner @stryker-mutator/typescript-checker';
const SPECPILOT_WARNING =
  'specpilot is not installed: the hooks run npx --no specpilot and block every edit until specpilot is installed (see the README: install it from a npm pack tarball)';
const JEST_WARNING = 'jest is not installed: SpecPilot runs your tests with Jest';
const STRYKER_WARNING = `Stryker is not fully installed: specpilot mutate needs it. Run: ${MUTATION_INSTALL}`;

type Hook = { type: string; command: string };
type Group = { matcher?: string; hooks: Hook[] };

// Every package init looks for, so no warning is printed.
const ALL_PACKAGES = {
  devDependencies: {
    jest: '^30.0.0',
    '@stryker-mutator/core': '10.0.0',
    '@stryker-mutator/jest-runner': '10.0.0',
    '@stryker-mutator/typescript-checker': '10.0.0',
    specpilot: '^0.1.0',
  },
};

const template = (file: string): Buffer => fs.readFileSync(path.join(TEMPLATES, file));
const templateSettings = (): { hooks: { PreToolUse: Group[]; Stop: Group[] } } =>
  JSON.parse(template(SETTINGS).toString('utf8'));

function runInit(cwd: string) {
  const { CLAUDE_PROJECT_DIR, SPECPILOT_TASK, ...env } = process.env;
  void CLAUDE_PROJECT_DIR;
  void SPECPILOT_TASK;
  return spawnSync(process.execPath, [BIN, 'init'], { encoding: 'utf8', cwd, env });
}

const lines = (text: string) => text.split('\n').filter((line) => line !== '');
const warnings = (stdout: string) => lines(stdout).filter((line) => line.startsWith('warning: '));
const stderrLines = (stderr: string) => lines(stderr);

// Every file under dir, relative with forward slashes, with its bytes and mtime.
function snapshot(dir: string): Record<string, { bytes: string; mtimeMs: number }> {
  const out: Record<string, { bytes: string; mtimeMs: number }> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, entry);
    if (!fs.statSync(full).isFile()) continue;
    out[entry.split(path.sep).join('/')] = {
      bytes: fs.readFileSync(full).toString('base64'),
      mtimeMs: fs.statSync(full).mtimeMs,
    };
  }
  return out;
}

const bytesOf = (snap: ReturnType<typeof snapshot>) =>
  Object.fromEntries(Object.entries(snap).map(([file, { bytes }]) => [file, bytes]));

// Every entry (files and folders) under dir, relative with forward slashes.
const entries = (dir: string) =>
  (fs.readdirSync(dir, { recursive: true }) as string[]).map((entry) => entry.split(path.sep).join('/')).sort();

describe('specpilot init', () => {
  let project: string;
  const at = (file: string) => path.join(project, file);
  const read = (file: string) => fs.readFileSync(at(file));
  const exists = (file: string) => fs.existsSync(at(file));
  const write = (file: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(at(file)), { recursive: true });
    fs.writeFileSync(at(file), content);
  };
  const writePackage = (pkg: unknown) => write('package.json', JSON.stringify(pkg, null, 2) + '\n');
  const copyFixture = (name: string) => fs.cpSync(path.join(FIXTURES, name), project, { recursive: true });

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-init-cli-'));
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  const expectInstalled = (files = FILES) => {
    for (const file of files) {
      expect({ file, exists: exists(file) }).toEqual({ file, exists: true });
      expect({ file, equal: exists(file) && read(file).equals(template(file)) }).toEqual({ file, equal: true });
    }
  };

  describe('AC-1: a Node + TypeScript project', () => {
    test('AC-1: exits 0 and installs the 3 files byte for byte equal to their templates', () => {
      copyFixture('node-ts');
      expect(exists('.claude')).toBe(false);
      const result = runInit(project);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expectInstalled();
    });

    test('AC-1: stdout has one "created <path>" line for each of the 3 files, and only warnings besides', () => {
      copyFixture('node-ts');
      const result = runInit(project);
      const out = lines(result.stdout);
      expect(out.filter((line) => line.startsWith('created ')).sort()).toEqual(FILES.map((f) => `created ${f}`).sort());
      for (const line of out) {
        expect({ line, ok: line.startsWith('created ') || line.startsWith('warning: ') }).toEqual({ line, ok: true });
      }
    });

    test('AC-1: no file of the fixture changes', () => {
      copyFixture('node-ts');
      const before = bytesOf(snapshot(project));
      const result = runInit(project);
      expect(result.status).toBe(0);
      const after = bytesOf(snapshot(project));
      for (const file of FILES) expect(after[file]).toBeDefined();
      const fixtureAfter = Object.fromEntries(Object.entries(after).filter(([file]) => !file.startsWith('.claude/')));
      expect(fixtureAfter).toEqual(before);
    });
  });

  describe('AC-2: a React + TypeScript project', () => {
    test('AC-2: exits 0, installs the 3 files equal to their templates and changes no fixture file', () => {
      copyFixture('react-ts');
      expect(exists('.claude')).toBe(false);
      const before = bytesOf(snapshot(project));
      const result = runInit(project);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expectInstalled();
      const after = bytesOf(snapshot(project));
      const fixtureAfter = Object.fromEntries(Object.entries(after).filter(([file]) => !file.startsWith('.claude/')));
      expect(fixtureAfter).toEqual(before);
    });
  });

  describe('AC-3: running it twice', () => {
    test('AC-3: the second run exits 0, keeps every byte and mtime, and says nothing changed', () => {
      copyFixture('node-ts');
      const first = runInit(project);
      expect(first.status).toBe(0);
      expectInstalled();
      const before = snapshot(project);

      const second = runInit(project);
      expect(second.stderr).toBe('');
      expect(second.status).toBe(0);
      expect(snapshot(project)).toEqual(before);
      expect(lines(second.stdout)).toContain('SpecPilot is already installed: nothing changed.');
      for (const line of lines(second.stdout)) {
        expect(line).not.toMatch(/^(created|updated|kept) /);
      }
    });
  });

  describe('AC-4: an existing settings.json', () => {
    const LINT: Group = { matcher: 'Write', hooks: [{ type: 'command', command: './lint.sh' }] };
    const PERMISSIONS = { allow: ['Bash(ls)'] };

    test('AC-4: keeps the permissions and the ./lint.sh group first, and appends the template groups', () => {
      copyFixture('node-ts');
      write(SETTINGS, JSON.stringify({ permissions: PERMISSIONS, hooks: { PreToolUse: [LINT] } }, null, 2) + '\n');
      const result = runInit(project);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      const tmpl = templateSettings();
      const expected = {
        permissions: PERMISSIONS,
        hooks: { PreToolUse: [LINT, ...tmpl.hooks.PreToolUse], Stop: [...tmpl.hooks.Stop] },
      };
      const text = read(SETTINGS).toString('utf8');
      expect(JSON.parse(text)).toEqual(expected);
      expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + '\n');
      expect(lines(result.stdout)).toContain('updated .claude/settings.json (added SpecPilot hooks)');
      expectInstalled([SKILL, AUDITOR]);
    });

    test('AC-4: with a PreToolUse group that already runs "npx specpilot hook pre-tool-use --roles", only the Stop group is added', () => {
      copyFixture('node-ts');
      const roles: Group = {
        matcher: 'Write|Edit|MultiEdit|NotebookEdit|Bash',
        hooks: [{ type: 'command', command: 'npx specpilot hook pre-tool-use --roles' }],
      };
      write(SETTINGS, JSON.stringify({ permissions: PERMISSIONS, hooks: { PreToolUse: [roles] } }, null, 2) + '\n');
      const result = runInit(project);
      expect(result.status).toBe(0);

      const text = read(SETTINGS).toString('utf8');
      expect(JSON.parse(text)).toEqual({
        permissions: PERMISSIONS,
        hooks: { PreToolUse: [roles], Stop: [...templateSettings().hooks.Stop] },
      });
      expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + '\n');
      expect(lines(result.stdout)).toContain('updated .claude/settings.json (added SpecPilot hooks)');
    });

    test('AC-4: a settings.json that already has both SpecPilot hooks keeps every byte', () => {
      copyFixture('node-ts');
      // Compact and with no final newline, so any rewrite shows.
      const text = JSON.stringify({
        permissions: PERMISSIONS,
        hooks: {
          PreToolUse: [LINT, { matcher: 'Bash', hooks: [{ type: 'command', command: 'npx specpilot hook pre-tool-use' }] }],
          Stop: [{ hooks: [{ type: 'command', command: 'npx specpilot hook stop' }] }],
        },
      });
      write(SETTINGS, text);
      const result = runInit(project);
      expect(result.status).toBe(0);
      expect(lines(result.stdout)).toEqual(expect.arrayContaining([`created ${SKILL}`, `created ${AUDITOR}`]));
      expect(read(SETTINGS).toString('utf8')).toBe(text);
      for (const line of lines(result.stdout)) expect(line).not.toContain(SETTINGS);
    });

    test('AC-4: a second run after the merge keeps every byte of settings.json', () => {
      copyFixture('node-ts');
      write(SETTINGS, JSON.stringify({ permissions: PERMISSIONS, hooks: { PreToolUse: [LINT] } }, null, 2) + '\n');
      expect(runInit(project).status).toBe(0);
      const merged = read(SETTINGS).toString('utf8');
      expect(JSON.parse(merged).hooks.Stop).toEqual(templateSettings().hooks.Stop);

      const second = runInit(project);
      expect(second.status).toBe(0);
      expect(read(SETTINGS).toString('utf8')).toBe(merged);
      expect(lines(second.stdout)).toContain('SpecPilot is already installed: nothing changed.');
    });

    test('AC-4: a settings.json with permissions and no hooks gains both template groups', () => {
      copyFixture('node-ts');
      write(SETTINGS, JSON.stringify({ permissions: PERMISSIONS }, null, 2) + '\n');
      const result = runInit(project);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      const tmpl = templateSettings();
      const text = read(SETTINGS).toString('utf8');
      expect(JSON.parse(text)).toEqual({
        permissions: PERMISSIONS,
        hooks: { PreToolUse: [...tmpl.hooks.PreToolUse], Stop: [...tmpl.hooks.Stop] },
      });
      expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2) + '\n');
      expect(lines(result.stdout)).toContain('updated .claude/settings.json (added SpecPilot hooks)');
    });

    test('AC-4: groups with no hooks array, or a hook with no command, are kept and the template groups are appended', () => {
      copyFixture('node-ts');
      const noHooks = { matcher: 'Write' };
      const noCommand = { matcher: 'Edit', hooks: [{ type: 'command' }] };
      const stopNoCommand = { hooks: [{ type: 'command' }] };
      write(
        SETTINGS,
        JSON.stringify({ permissions: PERMISSIONS, hooks: { PreToolUse: [noHooks, noCommand], Stop: [stopNoCommand] } }, null, 2) +
          '\n',
      );
      const result = runInit(project);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      const tmpl = templateSettings();
      expect(JSON.parse(read(SETTINGS).toString('utf8'))).toEqual({
        permissions: PERMISSIONS,
        hooks: {
          PreToolUse: [noHooks, noCommand, ...tmpl.hooks.PreToolUse],
          Stop: [stopNoCommand, ...tmpl.hooks.Stop],
        },
      });
      expect(lines(result.stdout)).toContain('updated .claude/settings.json (added SpecPilot hooks)');
    });

    test('AC-4: other hook events (PostToolUse) are kept, in their place', () => {
      copyFixture('node-ts');
      const post: Group = { matcher: 'Write', hooks: [{ type: 'command', command: './format.sh' }] };
      write(SETTINGS, JSON.stringify({ permissions: PERMISSIONS, hooks: { PostToolUse: [post], PreToolUse: [LINT] } }, null, 2) + '\n');
      const result = runInit(project);
      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);

      const tmpl = templateSettings();
      const merged = JSON.parse(read(SETTINGS).toString('utf8'));
      expect(merged).toEqual({
        permissions: PERMISSIONS,
        hooks: { PostToolUse: [post], PreToolUse: [LINT, ...tmpl.hooks.PreToolUse], Stop: [...tmpl.hooks.Stop] },
      });
      expect(Object.keys(merged)).toEqual(['permissions', 'hooks']);
      expect(Object.keys(merged.hooks)).toEqual(['PostToolUse', 'PreToolUse', 'Stop']);
    });
  });

  describe('AC-5: a corrupt settings.json', () => {
    const NOT_JSON = 'Corrupt .claude/settings.json: not valid JSON';
    const ROOT = 'Corrupt .claude/settings.json: the root is not an object';
    const HOOKS = 'Corrupt .claude/settings.json: "hooks" is not an object';
    const PRE = 'Corrupt .claude/settings.json: "hooks.PreToolUse" is not an array';
    const STOP = 'Corrupt .claude/settings.json: "hooks.Stop" is not an array';

    test.each([
      ['not valid JSON', '{ "hooks": ', NOT_JSON],
      ['null', 'null', ROOT],
      ['an array', '[]', ROOT],
      ['a number', '42', ROOT],
      ['hooks is a string', '{"hooks": "x"}', HOOKS],
      ['hooks is an array', '{"hooks": []}', HOOKS],
      ['hooks is null', '{"hooks": null}', HOOKS],
      ['hooks.PreToolUse is not an array', '{"hooks": {"PreToolUse": {}}}', PRE],
      ['hooks.PreToolUse is null', '{"hooks": {"PreToolUse": null}}', PRE],
      ['hooks.Stop is not an array', '{"hooks": {"Stop": "x"}}', STOP],
    ])('AC-5: %s exits 1 naming the file, before any write', (_shape, text, message) => {
      copyFixture('node-ts');
      write(SETTINGS, text);
      const result = runInit(project);
      expect(result.status).toBe(1);
      expect(stderrLines(result.stderr)).toHaveLength(1);
      expect(result.stderr).toContain('.claude/settings.json');
      expect(result.stderr).toBe(`${message}\n`);
      expect(read(SETTINGS).toString('utf8')).toBe(text);
      expect(exists(SKILL)).toBe(false);
      expect(exists(AUDITOR)).toBe(false);
      expect(entries(at('.claude'))).toEqual(['settings.json']);
    });
  });

  describe('AC-6: a changed template file', () => {
    test('AC-6: a grill-auditor.md that differs is kept and reported, and the other 2 files are created', () => {
      copyFixture('node-ts');
      write(AUDITOR, 'my own auditor\n');
      const result = runInit(project);
      expect(result.status).toBe(0);
      expect(read(AUDITOR).toString('utf8')).toBe('my own auditor\n');
      expect(lines(result.stdout)).toContain('kept .claude/agents/grill-auditor.md (differs from the template)');
      expectInstalled([SETTINGS, SKILL]);
      expect(lines(result.stdout)).toEqual(expect.arrayContaining([`created ${SETTINGS}`, `created ${SKILL}`]));
    });

    test('AC-6: a grill-auditor.md equal to its template is not named on stdout', () => {
      copyFixture('node-ts');
      write(AUDITOR, template(AUDITOR));
      const result = runInit(project);
      expect(result.status).toBe(0);
      expectInstalled();
      expect(lines(result.stdout)).toEqual(expect.arrayContaining([`created ${SETTINGS}`, `created ${SKILL}`]));
      for (const line of lines(result.stdout)) expect(line).not.toContain('grill-auditor.md');
    });
  });

  describe('AC-7: needs a package.json', () => {
    test('AC-7: with no package.json it exits 1, says to run at the project root, and creates nothing', () => {
      const result = runInit(project);
      expect(result.status).toBe(1);
      expect(stderrLines(result.stderr)).toHaveLength(1);
      expect(result.stderr).toContain('package.json');
      expect(result.stderr).toContain('project root');
      // process.cwd() in the CLI is the real path (on macOS /var is a link to /private/var).
      expect(result.stderr).toBe(
        `No package.json in ${fs.realpathSync(project)}: specpilot init must run at the project root\n`,
      );
      expect(entries(project)).toEqual([]);
    });

    test.each([
      ['not valid JSON', '{ "name": ', 'not valid JSON'],
      ['null', 'null', 'the root is not an object'],
      ['an array', '[]', 'the root is not an object'],
      ['a number', '42', 'the root is not an object'],
    ])('AC-7: a package.json that is %s exits 1 naming package.json and creates nothing', (_shape, text, reason) => {
      write('package.json', text);
      const result = runInit(project);
      expect(result.status).toBe(1);
      expect(stderrLines(result.stderr)).toHaveLength(1);
      expect(result.stderr).toContain('package.json');
      expect(result.stderr).toBe(
        `Corrupt package.json: ${reason} (${path.join(fs.realpathSync(project), 'package.json')})\n`,
      );
      expect(entries(project)).toEqual(['package.json']);
      expect(read('package.json').toString('utf8')).toBe(text);
    });
  });

  describe('AC-8: missing packages', () => {
    const without = (name: string) => {
      const devDependencies: Record<string, string> = { ...ALL_PACKAGES.devDependencies };
      delete devDependencies[name];
      return { name: 'sample', version: '1.0.0', devDependencies };
    };

    test('AC-8: without jest there is exactly one warning, and it names jest', () => {
      writePackage(without('jest'));
      const result = runInit(project);
      expect(result.status).toBe(0);
      expect(warnings(result.stdout)).toEqual([expect.stringContaining('jest')]);
      expect(warnings(result.stdout)).toEqual([`warning: ${JEST_WARNING}`]);
    });

    test.each([
      '@stryker-mutator/core',
      '@stryker-mutator/jest-runner',
      '@stryker-mutator/typescript-checker',
    ])('AC-8: without %s there is one warning with the Stryker install command', (name) => {
      writePackage(without(name));
      const result = runInit(project);
      expect(result.status).toBe(0);
      expect(warnings(result.stdout)).toEqual([expect.stringContaining(INSTALL)]);
      expect(MUTATION_INSTALL).toBe(INSTALL);
      expect(warnings(result.stdout)).toEqual([`warning: ${STRYKER_WARNING}`]);
    });

    test('AC-8: without specpilot there is one warning saying the hooks run npx --no specpilot', () => {
      writePackage(without('specpilot'));
      const result = runInit(project);
      expect(result.status).toBe(0);
      expect(warnings(result.stdout)).toEqual([expect.stringContaining('npx --no specpilot')]);
    });

    test('AC-8: without specpilot the warning has the exact text and points to the README', () => {
      writePackage(without('specpilot'));
      const result = runInit(project);
      expect(result.status).toBe(0);
      expect(warnings(result.stdout)).toEqual([
        'warning: specpilot is not installed: the hooks run npx --no specpilot and block every edit until specpilot is installed (see the README: install it from a npm pack tarball)',
      ]);
    });

    test('AC-8: no stdout line suggests npm i -D specpilot, with or without other packages', () => {
      for (const pkg of [without('specpilot'), { name: 'sample', version: '1.0.0' }]) {
        writePackage(pkg);
        const result = runInit(project);
        expect(result.status).toBe(0);
        for (const line of lines(result.stdout)) {
          expect({ line, suggests: line.includes('npm i -D specpilot') }).toEqual({ line, suggests: false });
        }
      }
    });

    test('AC-8: a project with no packages gets exactly the jest, Stryker and specpilot warning lines', () => {
      writePackage({ name: 'sample', version: '1.0.0' });
      const result = runInit(project);
      expect(result.status).toBe(0);
      // The spec does not pin the order of the warnings.
      expect([...warnings(result.stdout)].sort()).toEqual(
        [`warning: ${JEST_WARNING}`, `warning: ${STRYKER_WARNING}`, `warning: ${SPECPILOT_WARNING}`].sort(),
      );
    });

    test('AC-8: a project with no packages gets the jest, Stryker and specpilot warnings and still exits 0', () => {
      writePackage({ name: 'sample', version: '1.0.0' });
      const result = runInit(project);
      expect(result.status).toBe(0);
      const found = warnings(result.stdout);
      expect(found.some((line) => line.includes(INSTALL))).toBe(true);
      expect(found.some((line) => line.includes('npx --no specpilot'))).toBe(true);
      expect(found.some((line) => line.includes('jest') && !line.includes(INSTALL))).toBe(true);
      expectInstalled();
    });

    test('AC-8: with every package, split between dependencies and devDependencies, there is no warning', () => {
      writePackage({
        name: 'sample',
        version: '1.0.0',
        dependencies: { specpilot: '^0.1.0', '@stryker-mutator/core': '10.0.0' },
        devDependencies: {
          jest: '^30.0.0',
          '@stryker-mutator/jest-runner': '10.0.0',
          '@stryker-mutator/typescript-checker': '10.0.0',
        },
      });
      const result = runInit(project);
      expect(result.status).toBe(0);
      expectInstalled();
      expect(warnings(result.stdout)).toEqual([]);
    });
  });
});
