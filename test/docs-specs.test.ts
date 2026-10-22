import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

// SpecPilot's own specs live in docs/specs/, and every one of them must pass spec lint.
const REPO = path.join(__dirname, '..');
const BIN = path.join(REPO, 'dist', 'cli.js');
const DOCS_SPECS = path.join(REPO, 'docs', 'specs');

const specs = fs.existsSync(DOCS_SPECS)
  ? fs.readdirSync(DOCS_SPECS).filter((name) => name.endsWith('.md')).sort()
  : [];

describe('docs/specs', () => {
  test('AC-11: every docs/specs/*.md, step-9.md and step-10.md included, passes specpilot spec lint', () => {
    expect(specs.length).toBeGreaterThan(0);
    expect(specs).toEqual(expect.arrayContaining(['step-9.md', 'step-10.md']));
    for (const name of specs) {
      const file = path.join('docs', 'specs', name);
      const result = spawnSync(process.execPath, [BIN, 'spec', 'lint', file], { encoding: 'utf8', cwd: REPO });
      expect({ file, status: result.status, stderr: result.stderr }).toEqual({ file, status: 0, stderr: '' });
    }
  });
});
