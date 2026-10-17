import fs from 'fs';
import path from 'path';
import { parseSpec, lintSpec } from '../src/spec';
import type { LintError } from '../src/spec';

const fixture = (name: string) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'specs', name), 'utf8');

const codes = (errors: LintError[]) => errors.map((e) => e.code);

describe('parseSpec', () => {
  test('extracts id, type, title and acceptance criteria', () => {
    const spec = parseSpec(fixture('valid.md'));

    expect(spec.id).toBe('TASK-101');
    expect(spec.type).toBe('endpoint-fields');
    expect(spec.title).toBe('Add phone field to POST /users');
    expect(spec.acceptanceCriteria).toEqual([
      {
        id: 'AC-1',
        title: 'Stores the phone when present in the payload',
        line: 12,
        given: ['a valid payload with `phone: "+34600000000"`'],
        when: ['POST /users is called'],
        then: ['it responds 201 and the stored user includes `phone`'],
      },
      {
        id: 'AC-2',
        title: 'Rejects phones with an invalid format',
        line: 17,
        given: ['a payload with `phone: "abc"`'],
        when: ['POST /users is called'],
        then: ['it responds 400 with `error.code = "INVALID_PHONE"`'],
      },
    ]);
  });

  test('an And step inherits the kind of the previous step', () => {
    const [ac] = parseSpec(fixture('with-and.md')).acceptanceCriteria;

    expect(ac.given).toEqual(['a user with id 42 exists', 'their phone_number is null']);
    expect(ac.when).toEqual(['I send PUT /users/42 with body {"phone_number": "+34623234321"}']);
    expect(ac.then).toEqual([
      'the response status is 200',
      'the user with id 42 has phone_number "+34623234321"',
    ]);
  });

  test('an And after When is another When', () => {
    const text = fixture('with-and.md').replace(
      '- Then the response status is 200',
      '- And the request has header X-Trace: 1\n- Then the response status is 200',
    );
    expect(parseSpec(text).acceptanceCriteria[0].when).toEqual([
      'I send PUT /users/42 with body {"phone_number": "+34623234321"}',
      'the request has header X-Trace: 1',
    ]);
  });

  test('missing steps are empty lists', () => {
    const text = fixture('with-and.md').replace(/- .*\n/g, '');
    const [ac] = parseSpec(text).acceptanceCriteria;
    expect([ac.given, ac.when, ac.then]).toEqual([[], [], []]);
  });

  test('ignores ### headings outside the acceptance criteria section', () => {
    const text = fixture('valid.md').replace('## Context', '## Context\n\n### Note');
    expect(parseSpec(text).acceptanceCriteria.map((ac) => ac.id)).toEqual(['AC-1', 'AC-2']);
    expect(lintSpec(text)).toEqual([]);
  });

  test('the title is the first # heading', () => {
    const text = `${fixture('valid.md')}\n# Final notes\n`;
    expect(parseSpec(text).title).toBe('Add phone field to POST /users');
  });
});

describe('lintSpec', () => {
  test('a valid spec has no errors', () => {
    expect(lintSpec(fixture('valid.md'))).toEqual([]);
  });

  test('a spec using And has no errors', () => {
    expect(lintSpec(fixture('with-and.md'))).toEqual([]);
  });

  test('an And with no previous step is an error', () => {
    const text = fixture('with-and.md').replace(
      '- Given a user with id 42 exists\n- And',
      '- And a user with id 42 exists\n- Given',
    );
    expect(lintSpec(text)).toEqual([
      {
        code: 'SPEC_AC_ORPHAN_AND',
        line: 10,
        message: 'AC-1: "And" has no previous Given/When/Then to continue',
      },
    ]);
  });

  test('requires frontmatter', () => {
    expect(codes(lintSpec(fixture('no-frontmatter.md')))).toEqual(['SPEC_MISSING_FRONTMATTER']);
  });

  test('frontmatter must start on the first line', () => {
    const text = `# Title\n---\nid: TASK-1\ntype: new-endpoint\n---\n${fixture('no-frontmatter.md')}`;
    expect(codes(lintSpec(text))).toEqual(['SPEC_MISSING_FRONTMATTER']);
  });

  test('a duplicated criterion only reports the duplicate', () => {
    const text = `${fixture('valid.md')}\n### AC-1: Repeated\n- Given something\n`;
    expect(codes(lintSpec(text))).toEqual(['SPEC_DUPLICATE_AC']);
  });

  test('reports every error with its line', () => {
    expect(lintSpec(fixture('invalid.md'))).toEqual([
      { code: 'SPEC_MISSING_ID', line: 1, message: 'Missing "id" in frontmatter' },
      {
        code: 'SPEC_INVALID_TYPE',
        line: 2,
        message: 'Invalid type "microservice". Use: new-endpoint, endpoint-fields, react-component',
      },
      { code: 'SPEC_DUPLICATE_AC', line: 13, message: 'AC-1 is duplicated' },
      {
        code: 'SPEC_AC_BAD_ID',
        line: 18,
        message: 'Criterion "Criterion without id" does not match "### AC-<n>: <title>"',
      },
      { code: 'SPEC_AC_INCOMPLETE', line: 23, message: 'AC-3 has no Then' },
    ]);
  });

  test('requires at least one acceptance criterion', () => {
    const text = '---\nid: TASK-1\ntype: new-endpoint\n---\n# Empty\n';
    expect(codes(lintSpec(text))).toEqual(['SPEC_NO_AC']);
  });

  test('requires a title', () => {
    const text = fixture('valid.md').replace('# Add phone field to POST /users\n', '');
    expect(codes(lintSpec(text))).toEqual(['SPEC_MISSING_TITLE']);
  });

  test('a criterion without Given and When reports both', () => {
    const text = fixture('valid.md').replace(
      '- Given a payload with `phone: "abc"`\n- When POST /users is called\n',
      '',
    );
    expect(lintSpec(text).map((e) => e.message)).toEqual([
      'AC-2 has no Given',
      'AC-2 has no When',
    ]);
  });

  test('the published template passes lint', () => {
    const template = fs.readFileSync(
      path.join(__dirname, '..', 'templates', 'spec.md'),
      'utf8',
    );
    expect(lintSpec(template)).toEqual([]);
  });
});
