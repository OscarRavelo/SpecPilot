import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

// Packs this repo (dist/ is built by `npm test`), installs the tarball offline into a
// project with no dependencies, and runs init through npx, as a user would.
const REPO = path.join(__dirname, '..');
const FILES = ['.claude/settings.json', '.claude/skills/sp-grill/SKILL.md', '.claude/agents/grill-auditor.md'];

// npm test sets npm_* variables (prefix, package, lifecycle) that would point npm at this repo.
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^npm_/i.test(key) || key === 'CLAUDE_PROJECT_DIR' || key === 'SPECPILOT_TASK') continue;
    env[key] = value;
  }
  return env;
}

const run = (command: string, args: string[], cwd: string) =>
  spawnSync(command, args, { cwd, encoding: 'utf8', env: cleanEnv() });

const lines = (text: string) => text.split('\n').filter((line) => line.trim() !== '');

describe('the packed npm package', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-init-pack-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  test('AC-10: the tarball ships the templates, and npx --no specpilot init installs them', () => {
    const packDir = path.join(tmp, 'pack');
    fs.mkdirSync(packDir);
    const pack = run('npm', ['pack', '--pack-destination', packDir], REPO);
    expect({ status: pack.status, stderr: pack.status === 0 ? '' : pack.stderr }).toEqual({ status: 0, stderr: '' });
    const tarball = path.join(packDir, lines(pack.stdout).pop() as string);
    expect(fs.existsSync(tarball)).toBe(true);

    const listing = lines(run('tar', ['-tzf', tarball], tmp).stdout);
    expect(listing).toEqual(expect.arrayContaining(FILES.map((file) => `package/templates/${file}`)));

    const project = path.join(tmp, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'sample', version: '1.0.0' }, null, 2) + '\n');
    const install = run('npm', ['install', '--offline', '--no-audit', '--no-fund', tarball], project);
    expect({ status: install.status, stderr: install.status === 0 ? '' : install.stderr }).toEqual({ status: 0, stderr: '' });

    const init = run('npx', ['--no', 'specpilot', 'init'], project);
    expect({ status: init.status, stderr: init.stderr }).toEqual({ status: 0, stderr: '' });

    const installedTemplates = path.join(project, 'node_modules', 'specpilot', 'templates');
    for (const file of FILES) {
      const target = path.join(project, file);
      const actual = fs.existsSync(target) ? fs.readFileSync(target) : null;
      const fromRepo = fs.readFileSync(path.join(REPO, 'templates', file));
      const fromTarball = fs.readFileSync(path.join(installedTemplates, file));
      expect({ file, equalToRepo: actual !== null && actual.equals(fromRepo) }).toEqual({ file, equalToRepo: true });
      expect({ file, equalToTarball: actual !== null && actual.equals(fromTarball) }).toEqual({
        file,
        equalToTarball: true,
      });
    }
    expect(lines(init.stdout).filter((line) => line.startsWith('created '))).toHaveLength(3);

    // The specpilot warning is the one about the hooks running npx --no specpilot (AC-8).
    const specpilotWarnings = lines(init.stdout).filter(
      (line) => line.startsWith('warning: ') && line.includes('npx --no specpilot'),
    );
    expect(specpilotWarnings).toEqual([]);
  }, 120000);
});
