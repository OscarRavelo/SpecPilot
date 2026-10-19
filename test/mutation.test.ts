import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  bugProblems,
  mutantId,
  nodeVersionProblem,
  parseEquivalents,
  parseStrykerReport,
  readMutationEvidence,
  renderEquivalents,
  runStryker,
  strykerConfig,
  survivors,
  unapprovedSurvivors,
  writeMutationEvidence,
} from '../src/mutation';
import type { Equivalent, Mutant, MutantStatus, MutationEvidence } from '../src/mutation';
import type { JestAssertion, JestReport, JestSuite } from '../src/tdd';

const ROOT = '/project';
const REPORT = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'stryker', 'report.json'), 'utf8'));
const FAKE_STRYKER = path.join(__dirname, 'fixtures', 'stryker', 'fake-stryker.js');

// strykerConfig(files, reportFile, root): the root decides whether the TypeScript checker is used.
const configFor = strykerConfig as unknown as (files: string[], reportFile: string, root: string) => Record<string, unknown>;

const mutant = (file: string, line: number, mutator: string, replacement: string, status: MutantStatus): Mutant => ({
  id: `${file}:${line} ${mutator} ${replacement}`,
  file,
  line,
  mutator,
  replacement,
  status,
});

describe('mutantId', () => {
  test('is built from file:line, mutator and mutated code', () => {
    expect(mutantId('src/a.ts', 12, 'EqualityOperator', 'a !== b')).toBe('src/a.ts:12 EqualityOperator a !== b');
  });

  test('collapses the whitespace of a multi-line replacement and trims it, so it fits on one line', () => {
    expect(mutantId('src/a.ts', 3, 'BlockStatement', '{\n    return 0;\n  }')).toBe('src/a.ts:3 BlockStatement { return 0; }');
    expect(mutantId('src/a.ts', 3, 'StringLiteral', '  "x"\t ')).toBe('src/a.ts:3 StringLiteral "x"');
  });
});

describe('strykerConfig', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-stryker-config-'));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('mutates only the given files with Jest and a JSON report', () => {
    const config = configFor(['src/a.ts', 'src/b.ts'], '/tmp/out/report.json', root);
    expect(config.mutate).toEqual(['src/a.ts', 'src/b.ts']);
    expect(config.testRunner).toBe('jest');
    expect(config.reporters).toContain('json');
    expect(config.jsonReporter).toEqual({ fileName: '/tmp/out/report.json' });
    expect(config.coverageAnalysis).toBe('perTest');
  });

  test('uses the TypeScript checker when the project root has a tsconfig.json', () => {
    fs.writeFileSync(path.join(root, 'tsconfig.json'), '{}\n');
    expect(configFor(['src/a.ts'], '/tmp/out/report.json', root).checkers).toEqual(['typescript']);
  });

  test('uses no checker when the project root has no tsconfig.json', () => {
    const config = configFor(['src/a.js'], '/tmp/out/report.json', root);
    expect(config.checkers ?? []).toEqual([]);
  });

  // Stryker adds "// @ts-nocheck" to every file disableTypeChecks matches. Its default matches test/ too,
  // fixtures included, which shifts their line numbers; only the mutated files may get it.
  describe('disableTypeChecks', () => {
    test('is a brace list of exactly the mutated files when there are several', () => {
      expect(configFor(['src/a.ts', 'src/b.ts'], '/tmp/out/report.json', root).disableTypeChecks).toBe('{src/a.ts,src/b.ts}');
    });

    test('is the path itself when one file is mutated', () => {
      expect(configFor(['src/a.ts'], '/tmp/out/report.json', root).disableTypeChecks).toBe('src/a.ts');
    });

    // Stryker turns every backslash into "/" before matching, so glob characters are escaped as
    // character classes (like minimatch.escape with windowsPathsNoEscape), never with backslashes.
    test('escapes glob brackets as character classes, so a Next.js-style file matches only itself', () => {
      expect(configFor(['src/[id].ts'], '/tmp/out/report.json', root).disableTypeChecks).toBe('src/[[]id[]].ts');
    });

    test('escapes * ? ( ) as character classes', () => {
      expect(configFor(['src/a*b.ts'], '/tmp/out/report.json', root).disableTypeChecks).toBe('src/a[*]b.ts');
      expect(configFor(['src/q?.ts'], '/tmp/out/report.json', root).disableTypeChecks).toBe('src/q[?].ts');
      expect(configFor(['src/(x).ts'], '/tmp/out/report.json', root).disableTypeChecks).toBe('src/[(]x[)].ts');
    });

    // A {a,b} list cannot hold a path with "{", "}" or ",": the file has to be renamed.
    test.each([
      ['src/a,b.ts', ['src/a,b.ts']],
      ['src/{x}.ts', ['src/{x}.ts']],
      ['src/x}.ts', ['src/x}.ts']],
      ['src/a,b.ts', ['src/b.ts', 'src/a,b.ts']],
      ['src/{x}.ts', ['src/{x}.ts', 'src/b.ts']],
      ['src/x}.ts', ['src/b.ts', 'src/x}.ts']],
    ])('throws, naming %s and asking to rename it, for %j', (name, files) => {
      expect(() => configFor(files, '/tmp/out/report.json', root)).toThrow(/rename/);
      expect(() => configFor(files, '/tmp/out/report.json', root)).toThrow(name);
    });

    // Stryker resolves the pattern with minimatch, which it depends on; skipped if it is not installed.
    let minimatch: ((file: string, pattern: string, options: { dot: boolean }) => boolean) | null;
    try {
      minimatch = require('minimatch').minimatch;
    } catch {
      minimatch = null;
    }
    const withMinimatch = minimatch ? test : test.skip;

    // Stryker's own step (core/dist/src/config/file-matcher.js): both the pattern and the file are
    // resolved against the project root and their backslashes turned into "/", then matched with dot: true.
    const norm = (s: string) => s.replace(/\\/g, '/');
    const strykerMatches = (projectRoot: string, pattern: string, file: string) =>
      (minimatch as NonNullable<typeof minimatch>)(
        norm(path.resolve(projectRoot, file)),
        norm(path.resolve(projectRoot, pattern)),
        { dot: true },
      );
    const patternFor = (files: string[]) => {
      const pattern = configFor(files, '/tmp/out/report.json', root).disableTypeChecks;
      expect(typeof pattern).toBe('string');
      expect(pattern as string).not.toContain('\\');
      return pattern as string;
    };
    const NOT_MUTATED = ['src/i.ts', 'src/c.ts', 'test/a.test.ts', 'test/fixtures/x.ts'];

    withMinimatch('matches every mutated file and no test or fixture file', () => {
      const files = ['src/a.ts', 'src/b.ts'];
      const pattern = patternFor(files);
      for (const file of files) expect([file, strykerMatches(root, pattern, file)]).toEqual([file, true]);
      for (const file of NOT_MUTATED) expect([file, strykerMatches(root, pattern, file)]).toEqual([file, false]);
    });

    test.each(['src/[id].ts', 'src/a*b.ts', 'src/(x).ts', 'src/q?.ts'])(
      'a mutated %s matches itself, alone and in a list, and no other file',
      (name) => {
        if (!minimatch) return;
        const lookalikes = ['src/axb.ts', 'src/axxb.ts', 'src/qz.ts', 'src/x.ts', 'src/d.ts'].filter((other) => other !== name);
        for (const files of [[name], [name, 'src/b.ts'], ['src/b.ts', name]]) {
          const pattern = patternFor(files);
          for (const file of files) expect([files, file, strykerMatches(root, pattern, file)]).toEqual([files, file, true]);
          for (const file of [...NOT_MUTATED, ...lookalikes]) {
            expect([files, file, strykerMatches(root, pattern, file)]).toEqual([files, file, false]);
          }
        }
      },
    );
  });

  // Stryker matches every mutate entry on its own (core/dist/src/fs/project-reader.js) with
  // new FileMatcher(entry, false): minimatch with dot: false, after resolving both against the project
  // root and turning backslashes into "/". So each entry is one file, escaped with character classes.
  describe('mutate', () => {
    let minimatch: ((file: string, pattern: string, options: { dot: boolean }) => boolean) | null;
    try {
      minimatch = require('minimatch').minimatch;
    } catch {
      minimatch = null;
    }

    const norm = (s: string) => s.replace(/\\/g, '/');
    const strykerMutates = (projectRoot: string, entry: string, file: string) =>
      (minimatch as NonNullable<typeof minimatch>)(
        norm(path.resolve(projectRoot, file)),
        norm(path.resolve(projectRoot, entry)),
        { dot: false },
      );
    const mutateFor = (files: string[]) => configFor(files, '/tmp/out/report.json', root).mutate as string[];

    test('escapes * ? ( ) [ ] in each entry as character classes, without braces or backslashes', () => {
      expect(mutateFor(['src/[id].ts'])).toEqual(['src/[[]id[]].ts']);
      expect(mutateFor(['src/a*b.ts', 'src/q?.ts', 'src/(x).ts'])).toEqual(['src/a[*]b.ts', 'src/q[?].ts', 'src/[(]x[)].ts']);
      expect(mutateFor(['src/b.ts', 'src/v1.2/[id].ts'])).toEqual(['src/b.ts', 'src/v1.2/[[]id[]].ts']);
    });

    test.each([
      ['src/[id].ts', 'src/[[]id[]].ts'],
      ['src/a*b.ts', 'src/a[*]b.ts'],
      ['src/(x).ts', 'src/[(]x[)].ts'],
      ['src/q?.ts', 'src/q[?].ts'],
    ])(
      'the entry for %s is %s and makes Stryker mutate exactly that file and no lookalike',
      (name, escaped) => {
        const lookalikes = ['src/i.ts', 'src/d.ts', 'src/axb.ts', 'src/qz.ts', 'src/x.ts', 'src/b.ts'].filter((other) => other !== name);
        const files = [name, 'src/b.ts'];
        const entries = mutateFor(files);
        expect(entries).toEqual([escaped, 'src/b.ts']);
        if (!minimatch) return;
        for (const entry of entries) {
          expect(entry).not.toContain('\\');
          expect(entry).not.toMatch(/[{}]/);
        }
        expect([entries[0], name, strykerMutates(root, entries[0], name)]).toEqual([entries[0], name, true]);
        for (const file of lookalikes) {
          expect([entries[0], file, strykerMutates(root, entries[0], file)]).toEqual([entries[0], file, false]);
        }
      },
    );

    // Stryker never lists files under a folder whose name starts with ".", so it would mutate nothing there.
    test.each([
      ['src/.internal/x.ts', ['src/.internal/x.ts']],
      ['.config/a.ts', ['.config/a.ts']],
      ['src/.x/a.js', ['src/b.ts', 'src/.x/a.js']],
    ])('throws, naming %s and saying Stryker skips hidden folders, for %j', (name, files) => {
      expect(() => configFor(files, '/tmp/out/report.json', root)).toThrow(/hidden/);
      expect(() => configFor(files, '/tmp/out/report.json', root)).toThrow(name);
    });
  });
});

describe('nodeVersionProblem', () => {
  test('Node 20 is too old for Stryker, and the message says how to fix it', () => {
    expect(nodeVersionProblem('20.11.0')).toBe(
      'Stryker needs Node >= 22, but this is Node 20.11.0: upgrade Node and run specpilot mutate again',
    );
  });

  test('Node 18 is too old for Stryker', () => {
    expect(nodeVersionProblem('18.0.0')).toBe(
      'Stryker needs Node >= 22, but this is Node 18.0.0: upgrade Node and run specpilot mutate again',
    );
  });

  test('Node 21.99 is still too old for Stryker', () => {
    expect(nodeVersionProblem('21.99.0')).toBe(
      'Stryker needs Node >= 22, but this is Node 21.99.0: upgrade Node and run specpilot mutate again',
    );
  });

  test('a version with a leading v is read, and Node v20 is too old', () => {
    const problem = nodeVersionProblem('v20.1.0');
    expect(problem).toContain('Stryker needs Node >= 22, but this is Node ');
    expect(problem).toContain('20.1.0: upgrade Node and run specpilot mutate again');
  });

  test('a version that cannot be read is a problem, not a pass', () => {
    expect(nodeVersionProblem('garbage')).toEqual(expect.any(String));
  });

  test.each(['22.0.0', '22.11.1', '25.2.1'])('Node %s is fine', (version) => {
    expect(nodeVersionProblem(version)).toBeNull();
  });
});

describe('runStryker', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-run-stryker-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  // An installed Stryker whose `stryker` bin is the fake one: it records each config and writes a report.
  const installFakeStryker = (where: string) => {
    const core = path.join(where, 'node_modules', '@stryker-mutator', 'core');
    fs.mkdirSync(core, { recursive: true });
    fs.writeFileSync(path.join(core, 'package.json'), JSON.stringify({ name: '@stryker-mutator/core', version: '0.0.0' }));
    const bin = path.join(where, 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.copyFileSync(FAKE_STRYKER, path.join(bin, 'stryker'));
    fs.chmodSync(path.join(bin, 'stryker'), 0o755);
  };
  const callsIn = (where: string) => JSON.parse(fs.readFileSync(path.join(where, 'stryker-calls.json'), 'utf8'));
  const SURVIVOR = { id: '1', mutatorName: 'BooleanLiteral', replacement: 'false', status: 'Survived', location: { start: { line: 2, column: 1 } } };

  test('without Stryker installed it says how to install it', () => {
    expect(() => runStryker(dir, ['src/a.js'])).toThrow(
      'Stryker is not installed in this project: run npm i -D @stryker-mutator/core @stryker-mutator/jest-runner @stryker-mutator/typescript-checker',
    );
  });

  test('runs Stryker over the given files and returns its JSON report', () => {
    installFakeStryker(dir);
    fs.writeFileSync(path.join(dir, 'stryker-mutants.json'), JSON.stringify({ 'src/a.js': [SURVIVOR] }));
    const report = runStryker(dir, ['src/a.js']);
    expect(parseStrykerReport(report, dir)).toEqual([mutant('src/a.js', 2, 'BooleanLiteral', 'false', 'Survived')]);
    expect(callsIn(dir)).toEqual([expect.objectContaining({ mutate: ['src/a.js'], testRunner: 'jest' })]);
  });

  test('finds Stryker installed in a parent folder, as Node does', () => {
    installFakeStryker(dir);
    const project = path.join(dir, 'packages', 'app');
    fs.mkdirSync(project, { recursive: true });
    expect(() => runStryker(project, ['src/a.js'])).not.toThrow();
  });

  test('a Stryker run that writes no JSON report is an error', () => {
    installFakeStryker(dir);
    fs.writeFileSync(path.join(dir, 'stryker-mutants.json'), JSON.stringify('no-report'));
    expect(() => runStryker(dir, ['src/a.js'])).toThrow('Stryker did not write a JSON report: see its output above');
  });

  test('passes no TypeScript checker to Stryker in a project without tsconfig.json', () => {
    installFakeStryker(dir);
    runStryker(dir, ['src/a.js']);
    expect(callsIn(dir)[0].checkers ?? []).toEqual([]);
  });

  test('passes the TypeScript checker to Stryker in a project with tsconfig.json', () => {
    installFakeStryker(dir);
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}\n');
    runStryker(dir, ['src/a.ts']);
    expect(callsIn(dir)[0].checkers).toEqual(['typescript']);
  });
});

describe('parseStrykerReport', () => {
  test('reads every mutant of the Stryker JSON report with SpecPilot ids', () => {
    expect(parseStrykerReport(REPORT, ROOT)).toEqual([
      mutant('src/lib/max.ts', 1, 'EqualityOperator', 'a >= b', 'Survived'),
      mutant('src/lib/max.ts', 1, 'ConditionalExpression', 'true', 'Killed'),
      mutant('src/sum.ts', 1, 'BlockStatement', '{}', 'CompileError'),
      mutant('src/sum.ts', 2, 'ArithmeticOperator', 'a - b', 'Killed'),
      mutant('src/sum.ts', 2, 'ArithmeticOperator', 'a * b', 'Timeout'),
      mutant('src/sum.ts', 5, 'ArrowFunction', '() => undefined', 'NoCoverage'),
    ]);
  });

  test('ignores the id Stryker gives each mutant', () => {
    const ids = parseStrykerReport(REPORT, ROOT).map((m) => m.id);
    expect(ids).toContain('src/sum.ts:2 ArithmeticOperator a - b');
    for (const strykerId of ['0', '1', '2', '3', '7', '8']) expect(ids).not.toContain(strykerId);
  });

  test('absolute file paths become relative to the root, with forward slashes', () => {
    const report = {
      files: {
        [path.join(ROOT, 'src', 'deep', 'a.ts')]: {
          mutants: [
            {
              id: '42',
              mutatorName: 'BooleanLiteral',
              replacement: 'false',
              status: 'Survived',
              location: { start: { line: 3, column: 5 }, end: { line: 3, column: 9 } },
            },
          ],
        },
      },
    };
    expect(parseStrykerReport(report, ROOT)).toEqual([mutant('src/deep/a.ts', 3, 'BooleanLiteral', 'false', 'Survived')]);
  });

  test.each([[{}], [null], [{ files: 'src/a.ts' }]])('a report without "files" (%j) is an error', (report) => {
    expect(() => parseStrykerReport(report, ROOT)).toThrow('The Stryker report has no "files"');
  });

  test('a file without mutants gives none', () => {
    expect(parseStrykerReport({ files: { 'src/a.ts': { language: 'typescript', source: '' } } }, ROOT)).toEqual([]);
  });

  test('a mutant without a replacement has an empty one', () => {
    const report = {
      files: { 'src/a.ts': { mutants: [{ id: '0', mutatorName: 'BlockStatement', status: 'Survived', location: { start: { line: 4, column: 1 } } }] } },
    };
    const [only] = parseStrykerReport(report, ROOT);
    expect(only).toEqual(expect.objectContaining({ file: 'src/a.ts', line: 4, mutator: 'BlockStatement', replacement: '', status: 'Survived' }));
  });

  // equivalents.md trims each "###" heading, so an id with trailing whitespace could never be approved.
  test('a mutant without a replacement gets an id that equivalents.md can approve', () => {
    const report = {
      files: { 'src/a.ts': { mutants: [{ id: '0', mutatorName: 'BlockStatement', status: 'Survived', location: { start: { line: 4, column: 1 } } }] } },
    };
    const mutants = parseStrykerReport(report, ROOT);
    expect(mutants[0].id).toBe(mutants[0].id.trim());
    const approved = renderEquivalents('TASK-101', mutants, []).replace('- Approved: no', '- Approved: yes');
    expect(unapprovedSurvivors(mutants, parseEquivalents(approved))).toEqual([]);
  });
});

describe('survivors', () => {
  test('only Survived and NoCoverage mutants survive', () => {
    const all = parseStrykerReport(REPORT, ROOT);
    expect(survivors(all).map((m) => m.id)).toEqual([
      'src/lib/max.ts:1 EqualityOperator a >= b',
      'src/sum.ts:5 ArrowFunction () => undefined',
    ]);
  });

  test.each<MutantStatus>(['Killed', 'CompileError', 'Timeout'])('a %s mutant is not a survivor', (status) => {
    const alive = mutant('src/a.ts', 1, 'BooleanLiteral', 'false', 'Survived');
    const other = mutant('src/a.ts', 2, 'BooleanLiteral', 'true', status);
    expect(survivors([alive, other])).toEqual([alive]);
  });

  // No test killed them: Stryker never ran them (Pending), they crashed (RuntimeError), or a
  // "// Stryker disable" comment hid them (Ignored), and an agent can write such a comment.
  test.each<MutantStatus>(['Pending', 'RuntimeError', 'Ignored'])('a %s mutant is a survivor', (status) => {
    const killed = mutant('src/a.ts', 1, 'BooleanLiteral', 'false', 'Killed');
    const other = mutant('src/a.ts', 2, 'BooleanLiteral', 'true', status);
    expect(survivors([killed, other])).toEqual([other]);
  });

  test.each<MutantStatus>(['Pending', 'RuntimeError', 'Ignored'])('a %s mutant goes to equivalents.md and needs an approval', (status) => {
    const other = mutant('src/a.ts', 2, 'BooleanLiteral', 'true', status);
    expect(renderEquivalents('TASK-101', survivors([other]), [])).toContain(`### ${other.id}\n- Approved: no`);
    expect(unapprovedSurvivors([other], [])).toEqual([other]);
    expect(unapprovedSurvivors([other], [{ id: other.id, approved: true, reason: 'checked by the human' }])).toEqual([]);
  });
});

describe('equivalents.md', () => {
  const A = mutant('src/a.ts', 3, 'EqualityOperator', 'a >= b', 'Survived');
  const B = mutant('src/b.ts', 9, 'StringLiteral', '""', 'NoCoverage');
  const C = mutant('src/c.ts', 1, 'BooleanLiteral', 'true', 'Survived');

  test('parseEquivalents reads each ### id with its approval and reason', () => {
    const text = [
      '# Equivalent mutants: TASK-101',
      '',
      '### src/a.ts:3 EqualityOperator a >= b',
      '- Approved: yes',
      '- Reason: a and b are never equal here',
      '',
      '### src/b.ts:9 StringLiteral ""',
      '- Approved: no',
      '- Reason: ',
      '',
      '### src/c.ts:1 BooleanLiteral true',
      '- Approved: YES',
      '- Reason: dead flag',
      '',
      '### src/d.ts:4 BlockStatement {}',
      '- Reason: forgot to approve',
      '',
    ].join('\n');
    expect(parseEquivalents(text)).toEqual([
      { id: 'src/a.ts:3 EqualityOperator a >= b', approved: true, reason: 'a and b are never equal here' },
      { id: 'src/b.ts:9 StringLiteral ""', approved: false, reason: '' },
      { id: 'src/c.ts:1 BooleanLiteral true', approved: true, reason: 'dead flag' },
      { id: 'src/d.ts:4 BlockStatement {}', approved: false, reason: 'forgot to approve' },
    ]);
  });

  test('anything but "yes" is not an approval', () => {
    const text = '### src/a.ts:3 EqualityOperator a >= b\n- Approved: maybe\n- Reason: x\n';
    expect(parseEquivalents(text)).toEqual([{ id: 'src/a.ts:3 EqualityOperator a >= b', approved: false, reason: 'x' }]);
  });

  test('renderEquivalents writes one section per survivor, in order, new ones not approved', () => {
    const text = renderEquivalents('TASK-101', [A, B], []);
    const headings = text.split('\n').filter((line) => line.startsWith('### '));
    expect(headings).toEqual([`### ${A.id}`, `### ${B.id}`]);
    expect(text.match(/^- Approved: no$/gm)).toHaveLength(2);
    expect(text.match(/^- Reason:/gm)).toHaveLength(2);
  });

  test('renderEquivalents keeps the human approvals of surviving ids and drops the rest', () => {
    const previous: Equivalent[] = [
      { id: 'src/gone.ts:1 BooleanLiteral true', approved: true, reason: 'no longer exists' },
      { id: A.id, approved: true, reason: 'same behaviour' },
      { id: C.id, approved: false, reason: 'still thinking' },
    ];
    const text = renderEquivalents('TASK-101', [A, B, C], previous);
    expect(text).not.toContain('src/gone.ts');
    expect(parseEquivalents(text)).toEqual([
      { id: A.id, approved: true, reason: 'same behaviour' },
      { id: B.id, approved: false, reason: '' },
      { id: C.id, approved: false, reason: 'still thinking' },
    ]);
  });

  test('unapprovedSurvivors needs an approved entry with exactly the same id', () => {
    const killed = mutant('src/a.ts', 5, 'BooleanLiteral', 'false', 'Killed');
    const nearA: Equivalent = { id: 'src/a.ts:4 EqualityOperator a >= b', approved: true, reason: 'other line' };
    const equivalents: Equivalent[] = [nearA, { id: B.id, approved: true, reason: 'ok' }, { id: C.id, approved: false, reason: '' }];
    expect(unapprovedSurvivors([A, B, C, killed], equivalents)).toEqual([A, C]);
    expect(unapprovedSurvivors([A, B], [{ id: A.id, approved: true, reason: 'ok' }, { id: B.id, approved: true, reason: 'ok' }])).toEqual([]);
  });
});

describe('bugProblems', () => {
  const assertionFailure = (fullName: string): JestAssertion => ({
    fullName,
    status: 'failed',
    failureMessages: ['Error: expect(received).toBe(expected)\n\nExpected: 3\nReceived: -1'],
    failureDetails: [{ matcherResult: { name: 'toBe', pass: false } }],
  });
  const errorFailure = (fullName: string): JestAssertion => ({
    fullName,
    status: 'failed',
    failureMessages: ['TypeError: sum is not a function'],
    failureDetails: [{}],
  });
  const passed = (fullName: string): JestAssertion => ({ fullName, status: 'passed', failureMessages: [], failureDetails: [] });
  const suite = (file: string, assertions: JestAssertion[]): JestSuite => ({
    name: path.join(ROOT, file),
    status: assertions.some((a) => a.status === 'failed') ? 'failed' : 'passed',
    message: '',
    assertionResults: assertions,
  });
  const brokenSuite = (file: string): JestSuite => ({
    name: path.join(ROOT, file),
    status: 'failed',
    message: "  ● Test suite failed to run\n\n    src/sum.ts:2:3 - error TS2322: Type 'string' is not assignable to type 'number'.",
    assertionResults: [],
  });
  const report = (...suites: JestSuite[]): JestReport => {
    const all = suites.flatMap((s) => s.assertionResults);
    return { numTotalTests: all.length, numFailedTests: all.filter((a) => a.status === 'failed').length, testResults: suites };
  };

  test('a bug is caught when a test named with the AC fails on an assertion', () => {
    const caught = report(suite('test/sum.test.ts', [assertionFailure('sum AC-1: adds two numbers'), passed('sum AC-2: keeps zero')]));
    const missed = report(suite('test/sum.test.ts', [passed('sum AC-1: adds two numbers')]));
    expect(bugProblems(caught, 'AC-1', ROOT)).toEqual([]);
    expect(bugProblems(missed, 'AC-1', ROOT)).not.toEqual([]);
  });

  test('a bug that no test catches is a problem', () => {
    expect(bugProblems(report(suite('test/sum.test.ts', [passed('AC-1 adds')])), 'AC-1', ROOT)).not.toEqual([]);
  });

  test('a bug caught only by a test without the AC in its name is not caught', () => {
    const r = report(suite('test/sum.test.ts', [assertionFailure('adds two numbers'), passed('AC-1 adds')]));
    expect(bugProblems(r, 'AC-1', ROOT)).not.toEqual([]);
  });

  test('AC-12 in a test name does not count for AC-1', () => {
    const r = report(suite('test/sum.test.ts', [assertionFailure('AC-12 rejects big numbers')]));
    expect(bugProblems(r, 'AC-1', ROOT)).not.toEqual([]);
    expect(bugProblems(r, 'AC-12', ROOT)).toEqual([]);
  });

  // AC-1 counts only as a whole id: punctuation or the end of the name may follow it, but not
  // another digit or letter, a ".2" or "-x" that makes it a different id, and no letter may come right before it.
  test('a test name counts for AC-1 only when it holds AC-1 as a whole id', () => {
    const counts = [
      'AC-1 adds',
      'AC-1: adds',
      '(AC-1) adds',
      'adds [AC-1]',
      'adds AC-1',
      'adds AC-1.',
    ];
    const doesNotCount = ['AC-12 adds', 'AC-1x adds', 'AC-1a adds', 'AC-1.2 adds', 'AC-1-x adds', 'XAC-1 adds'];
    const caughtFor = (name: string) => bugProblems(report(suite('test/sum.test.ts', [assertionFailure(name)])), 'AC-1', ROOT).length === 0;
    expect(Object.fromEntries([...counts, ...doesNotCount].map((name) => [name, caughtFor(name)]))).toEqual({
      ...Object.fromEntries(counts.map((name) => [name, true])),
      ...Object.fromEntries(doesNotCount.map((name) => [name, false])),
    });
  });

  test('an AC test that fails with a thrown error, not an assertion, does not catch the bug', () => {
    const r = report(suite('test/sum.test.ts', [errorFailure('AC-1 adds')]));
    expect(bugProblems(r, 'AC-1', ROOT)).not.toEqual([]);
  });

  test('a suite that fails to run (a bug that does not compile) is not a caught bug', () => {
    const r = report(suite('test/sum.test.ts', [assertionFailure('AC-1 adds')]), brokenSuite('test/other.test.ts'));
    const problems = bugProblems(r, 'AC-1', ROOT);
    expect(problems).not.toEqual([]);
    expect(problems.join('\n')).toContain('test/other.test.ts failed to run');
  });
});

describe('mutation.json', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-mutation-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const evidence: MutationEvidence = {
    taskId: 'TASK-101',
    at: '2026-10-18T10:00:00.000Z',
    sourceFiles: { 'src/sum.ts': 'aaa' },
    testFiles: { 'test/sum.test.ts': 'bbb' },
    mutants: [mutant('src/sum.ts', 2, 'ArithmeticOperator', 'a - b', 'Killed')],
    bugs: [{ ac: 'AC-1', caught: true, at: '2026-10-18T10:05:00.000Z', sourceFiles: { 'src/sum.ts': 'ccc' }, failing: ['AC-1 adds'] }],
  };

  test('round-trips through specs/<task>/mutation.json, and is null when missing', () => {
    expect(readMutationEvidence(dir)).toBeNull();
    writeMutationEvidence(dir, evidence);
    expect(fs.existsSync(path.join(dir, 'mutation.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'mutation.json'), 'utf8'))).toEqual(evidence);
    expect(readMutationEvidence(dir)).toEqual(evidence);
  });

  test('a corrupt mutation.json is an error, not missing evidence', () => {
    fs.writeFileSync(path.join(dir, 'mutation.json'), '{nope');
    expect(() => readMutationEvidence(dir)).toThrow(/Corrupt mutation\.json/);
    fs.writeFileSync(path.join(dir, 'mutation.json'), '{"taskId":"TASK-101"}');
    expect(() => readMutationEvidence(dir)).toThrow(/Corrupt mutation\.json/);
  });

  test.each<[string, Record<string, unknown>]>([
    ['taskId is not a string', { taskId: 101 }],
    ['sourceFiles is missing', { sourceFiles: undefined }],
    ['sourceFiles is null', { sourceFiles: null }],
    ['testFiles is missing', { testFiles: undefined }],
    ['testFiles is null', { testFiles: null }],
    ['mutants is not a list', { mutants: {} }],
    ['bugs is not a list', { bugs: 'none' }],
  ])('mutation.json is corrupt when %s', (_, change) => {
    fs.writeFileSync(path.join(dir, 'mutation.json'), JSON.stringify({ ...evidence, ...change }));
    expect(() => readMutationEvidence(dir)).toThrow(`Corrupt mutation.json in ${dir}`);
  });

  const STATUSES: MutantStatus[] = ['Killed', 'Survived', 'NoCoverage', 'CompileError', 'Timeout', 'RuntimeError', 'Ignored', 'Pending'];

  test('a mutant with an unknown status is corrupt; every Stryker status is not', () => {
    const write = (status: string) =>
      fs.writeFileSync(
        path.join(dir, 'mutation.json'),
        JSON.stringify({ ...evidence, mutants: [{ ...evidence.mutants[0], status }] }),
      );
    for (const status of STATUSES) {
      write(status);
      expect(readMutationEvidence(dir)?.mutants[0].status).toBe(status);
    }
    write('Exploded');
    expect(() => readMutationEvidence(dir)).toThrow(/Corrupt mutation\.json/);
  });

  test.each<[string, Record<string, unknown>]>([
    ['its id is missing', { id: undefined }],
    ['its id is not a string', { id: 7 }],
    ['its file is missing', { file: undefined }],
    ['its file is not a string', { file: ['src/sum.ts'] }],
    ['its line is missing', { line: undefined }],
    ['its line is not a number', { line: '2' }],
    ['its mutator is missing', { mutator: undefined }],
    ['its mutator is not a string', { mutator: null }],
    ['its replacement is missing', { replacement: undefined }],
    ['its replacement is not a string', { replacement: 0 }],
    ['its status is missing', { status: undefined }],
  ])('a mutants entry is corrupt when %s', (_, change) => {
    const mutants = [evidence.mutants[0], { ...evidence.mutants[0], ...change }];
    fs.writeFileSync(path.join(dir, 'mutation.json'), JSON.stringify({ ...evidence, mutants }));
    expect(() => readMutationEvidence(dir)).toThrow(/Corrupt mutation\.json/);
  });

  test.each<[string, unknown]>([
    ['null', null],
    ['a string', 'src/sum.ts:2 ArithmeticOperator a - b'],
  ])('a mutants entry that is %s is corrupt', (_, entry) => {
    fs.writeFileSync(path.join(dir, 'mutation.json'), JSON.stringify({ ...evidence, mutants: [entry] }));
    expect(() => readMutationEvidence(dir)).toThrow(/Corrupt mutation\.json/);
  });

  test.each<[string, Record<string, unknown>]>([
    ['its ac is missing', { ac: undefined }],
    ['its ac is not a string', { ac: 1 }],
    ['its caught is missing', { caught: undefined }],
    ['its caught is not a boolean', { caught: 'yes' }],
    ['its at is missing', { at: undefined }],
    ['its at is not a string', { at: 1760781900000 }],
  ])('a bugs entry is corrupt when %s', (_, change) => {
    const bugs = [evidence.bugs[0], { ...evidence.bugs[0], ...change }];
    fs.writeFileSync(path.join(dir, 'mutation.json'), JSON.stringify({ ...evidence, bugs }));
    expect(() => readMutationEvidence(dir)).toThrow(/Corrupt mutation\.json/);
  });

  test.each<[string, unknown]>([
    ['null', null],
    ['a string', 'AC-1'],
  ])('a bugs entry that is %s is corrupt', (_, entry) => {
    fs.writeFileSync(path.join(dir, 'mutation.json'), JSON.stringify({ ...evidence, bugs: [entry] }));
    expect(() => readMutationEvidence(dir)).toThrow(/Corrupt mutation\.json/);
  });

  test('null in mutation.json is corrupt', () => {
    fs.writeFileSync(path.join(dir, 'mutation.json'), 'null');
    expect(() => readMutationEvidence(dir)).toThrow(`Corrupt mutation.json in ${dir}`);
  });
});
