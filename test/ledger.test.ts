import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseLedger, checkLedger } from '../src/ledger';
import type { LedgerError } from '../src/ledger';

const PROJECT = path.join(__dirname, 'fixtures', 'project');
const TASK = path.join(PROJECT, 'specs', 'TASK-102');
const LEDGER = fs.readFileSync(path.join(TASK, 'grill.md'), 'utf8');
const SPEC = fs.readFileSync(path.join(TASK, 'spec.md'), 'utf8');

const FACT_1 = '[repo:src/routes/users.ts:9 "export function updateUser("]';

const check = (ledger: string) => checkLedger(ledger, SPEC, PROJECT);
const codes = (errors: LedgerError[]) => errors.map((e) => e.code);
// Replaces the first fact's citation and checks the ledger.
const withCitation = (citation: string) => check(LEDGER.replace(FACT_1, citation));

describe('parseLedger', () => {
  test('extracts questions and facts with their citations', () => {
    const ledger = parseLedger(LEDGER);

    expect(ledger.questions).toEqual([
      {
        id: 'Q1',
        text: 'What should happen when phone_number has an invalid format?',
        line: 5,
        status: 'answered',
        answer: 'Respond 400 with error.code "INVALID_PHONE".',
        approved: false,
      },
      {
        id: 'Q2',
        text: 'Should PUT accept null to clear the phone number?',
        line: 9,
        status: 'assumption',
        answer: 'Yes, null clears it.',
        approved: true,
      },
    ]);
    expect(ledger.facts.map((f) => [f.line, f.citations])).toEqual([
      [16, [{ kind: 'repo', file: 'src/routes/users.ts', start: 9, end: 9, snippet: 'export function updateUser(' }]],
      [17, [{ kind: 'repo', file: 'src/routes/users.ts', start: 1, end: 5, snippet: 'phoneNumber: string | null;' }]],
      [18, [{ kind: 'spec', ac: 'AC-1' }]],
      [
        19,
        [
          { kind: 'human', question: 'Q1' },
          { kind: 'repo', file: 'src/routes/users.ts', start: 17, end: 17, snippet: 'PHONE_ERROR = "INVALID_PHONE"' },
        ],
      ],
      [20, [{ kind: 'human', question: 'Q2' }]],
    ]);
  });

  test('the fact text has its citations removed', () => {
    expect(parseLedger(LEDGER).facts.map((f) => f.text)).toEqual([
      'Users are updated by updateUser',
      'The User model already has a nullable phoneNumber field',
      'A successful update responds 200',
      'Invalid phone numbers respond 400 with INVALID_PHONE',
      'Sending null clears the phone number',
    ]);
  });

  test('reads the checklist topics a fact covers and strips them from its text', () => {
    const text = LEDGER.replace(
      '- Invalid phone numbers respond',
      '- (validation, errors) Invalid phone numbers respond',
    );
    const facts = parseLedger(text).facts;
    expect(facts[3].topics).toEqual(['validation', 'errors']);
    expect(facts[3].text).toBe('Invalid phone numbers respond 400 with INVALID_PHONE');
    expect(facts[0].topics).toEqual([]);
  });

  test('ignores bullets outside the Facts section', () => {
    const text = LEDGER.replace('## Questions', '- a note under the title\n\n## Questions\n\n- a loose note').replace(
      '## Facts',
      '## Notes\n\n- another note\n\n## Facts',
    );
    expect(parseLedger(text).facts).toHaveLength(5);
  });
});

describe('checkLedger: repo citations', () => {
  test('a ledger whose citations all hold has no errors', () => {
    expect(check(LEDGER)).toEqual([]);
  });

  test('a snippet that is not in the cited lines fails', () => {
    expect(withCitation('[repo:src/routes/users.ts:9 "export function updateUsers("]')).toEqual([
      {
        code: 'CITE_SNIPPET_MISMATCH',
        line: 16,
        message: '"export function updateUsers(" is not in src/routes/users.ts:9',
      },
    ]);
  });

  test('a real snippet cited at the wrong lines fails', () => {
    expect(withCitation('[repo:src/routes/users.ts:1-5 "export function updateUser("]')).toEqual([
      {
        code: 'CITE_SNIPPET_MISMATCH',
        line: 16,
        message: '"export function updateUser(" is not in src/routes/users.ts:1-5',
      },
    ]);
  });

  test('a snippet may span several cited lines', () => {
    expect(withCitation('[repo:src/routes/users.ts:10-11 "users.get(id);\\n  if (!user)"]')).toEqual([]);
  });

  test('a missing file fails', () => {
    expect(withCitation('[repo:src/routes/accounts.ts:9 "export function updateUser("]')).toEqual([
      { code: 'CITE_FILE_MISSING', line: 16, message: 'src/routes/accounts.ts does not exist' },
    ]);
  });

  test('a directory is not a file', () => {
    expect(withCitation('[repo:src/routes:1 "export function updateUser("]')).toEqual([
      { code: 'CITE_FILE_MISSING', line: 16, message: 'src/routes is not a file' },
    ]);
  });

  test.each([
    ['40', 'src/routes/users.ts has 17 lines; cited 40'],
    ['15-18', 'src/routes/users.ts has 17 lines; cited 15-18'],
    ['5-1', 'Invalid line range 5-1 in src/routes/users.ts'],
    ['0', 'Invalid line range 0 in src/routes/users.ts'],
  ])('line range %s fails', (range, message) => {
    expect(withCitation(`[repo:src/routes/users.ts:${range} "export function updateUser("]`)).toEqual([
      { code: 'CITE_LINES_OUT_OF_RANGE', line: 16, message },
    ]);
  });

  test.each(['../../spec.test.ts', '/etc/hosts', 'src/../../ledger.test.ts'])(
    'a file outside the project (%s) fails',
    (file) => {
      expect(codes(withCitation(`[repo:${file}:1 "something long"]`))).toEqual([
        'CITE_PATH_OUTSIDE_PROJECT',
      ]);
    },
  );

  test('a snippet shorter than 8 characters fails, so it cannot match by accident', () => {
    expect(withCitation('[repo:src/routes/users.ts:9 "("]')).toEqual([
      {
        code: 'CITE_SNIPPET_TOO_SHORT',
        line: 16,
        message: 'Snippet "(" is too short (at least 8 characters)',
      },
    ]);
  });

  test.each([
    '[repo:src/routes/users.ts:9]',
    '[repo:src/routes/users.ts "export function updateUser("]',
    '[repo:src/routes/users.ts:nine "export function updateUser("]',
  ])('a malformed repo citation fails: %s', (citation) => {
    expect(withCitation(citation)).toEqual([
      {
        code: 'CITE_MALFORMED',
        line: 16,
        message: `Malformed citation ${citation}. Use [repo:<file>:<line>[-<line>] "<snippet>"], [spec:AC-<n>] or [human:Q<n>]`,
      },
    ]);
  });

  test('CRLF line endings in the cited file still match', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'specpilot-crlf-'));
    try {
      fs.writeFileSync(path.join(tmp, 'a.ts'), 'const one = 1;\r\nconst two = 2;\r\n');
      const ledger = '## Facts\n\n- Two lines [repo:a.ts:1-2 "1;\\nconst two"]\n';
      expect(checkLedger(ledger, SPEC, tmp)).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('checkLedger: spec and human citations', () => {
  test('an acceptance criterion that is not in the spec fails', () => {
    expect(withCitation('[spec:AC-9]')).toEqual([
      { code: 'CITE_UNKNOWN_AC', line: 16, message: 'AC-9 is not in spec.md' },
    ]);
  });

  test('a question that is not in the ledger fails', () => {
    expect(withCitation('[human:Q9]')).toEqual([
      { code: 'CITE_UNKNOWN_QUESTION', line: 16, message: 'Q9 is not in the ledger' },
    ]);
  });

  test('an open question cannot be cited', () => {
    const text = LEDGER.replace('- Status: answered', '- Status: open').replace(
      '- Answer: Respond 400 with error.code "INVALID_PHONE".\n',
      '',
    );
    expect(check(text)).toEqual([
      { code: 'CITE_OPEN_QUESTION', line: 18, message: 'Q1 is still open' },
    ]);
  });

  test('an assumption the human has not approved cannot be cited', () => {
    expect(check(LEDGER.replace('- Approved: yes', '- Approved: no'))).toEqual([
      {
        code: 'CITE_UNAPPROVED_ASSUMPTION',
        line: 20,
        message: 'Q2 is an assumption the human has not approved',
      },
    ]);
  });
});

describe('checkLedger: ledger format', () => {
  test('a fact without citations fails', () => {
    const text = LEDGER.replace(' [spec:AC-1]', '');
    expect(check(text)).toEqual([
      {
        code: 'LEDGER_UNCITED',
        line: 18,
        message: 'Fact has no citation: "A successful update responds 200"',
      },
    ]);
  });

  test('only the bad citation of a fact is reported', () => {
    const text = LEDGER.replace('[human:Q1]', '[human:Q7]');
    expect(codes(check(text))).toEqual(['CITE_UNKNOWN_QUESTION']);
  });

  test('every error of a fact is reported, in order', () => {
    const text = LEDGER.replace('[spec:AC-1]', '[spec:AC-8] [human:Q8]');
    expect(codes(check(text))).toEqual(['CITE_UNKNOWN_AC', 'CITE_UNKNOWN_QUESTION']);
  });

  test('a topic that is not in the checklist of the task type fails', () => {
    const text = LEDGER.replace('- A successful update', '- (contract, colour) A successful update');
    expect(check(text)).toEqual([
      {
        code: 'LEDGER_UNKNOWN_TOPIC',
        line: 18,
        message:
          'Unknown topic "colour" for endpoint-fields. Use: contract, validation, errors, data, auth, compatibility, edge-cases, out-of-scope',
      },
    ]);
  });

  test('a duplicated question fails', () => {
    const text = LEDGER.replace('### Q2:', '### Q1:');
    expect(codes(check(text))).toContain('LEDGER_DUPLICATE_QUESTION');
    expect(check(text)[0]).toEqual({
      code: 'LEDGER_DUPLICATE_QUESTION',
      line: 9,
      message: 'Q1 is duplicated',
    });
  });

  test('a question heading without an id fails', () => {
    expect(check(LEDGER.replace('### Q2:', '### Second:'))[0]).toEqual({
      code: 'LEDGER_BAD_QUESTION_ID',
      line: 9,
      message:
        'Question "Second: Should PUT accept null to clear the phone number?" does not match "### Q<n>: <question>"',
    });
  });

  test('question errors are reported in line order', () => {
    const text = LEDGER.replace('### Q1:', '### First:').replace(
      '- Status: assumption',
      '- Status: maybe',
    );
    expect(codes(check(text)).slice(0, 2)).toEqual(['LEDGER_BAD_QUESTION_ID', 'LEDGER_BAD_STATUS']);
  });

  test('an unknown status fails', () => {
    expect(check(LEDGER.replace('- Status: answered', '- Status: maybe'))[0]).toEqual({
      code: 'LEDGER_BAD_STATUS',
      line: 5,
      message: 'Q1 has status "maybe". Use: open, answered, assumption',
    });
  });

  test('a question without status fails', () => {
    expect(check(LEDGER.replace('- Status: answered\n', ''))[0]).toEqual({
      code: 'LEDGER_BAD_STATUS',
      line: 5,
      message: 'Q1 has no status. Use: open, answered, assumption',
    });
  });

  test('an answered question or assumption needs an answer', () => {
    const text = LEDGER.replace('- Answer: Yes, null clears it.\n', '');
    expect(codes(check(text))).toEqual(['LEDGER_NO_ANSWER']);
    expect(check(text)[0]).toEqual({ code: 'LEDGER_NO_ANSWER', line: 9, message: 'Q2 has no answer' });
  });

  test('the published template passes the check', () => {
    const template = fs.readFileSync(path.join(__dirname, '..', 'templates', 'grill.md'), 'utf8');
    expect(checkLedger(template, SPEC, PROJECT)).toEqual([]);
  });
});
