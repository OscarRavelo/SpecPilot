import fs from 'fs';
import path from 'path';
import { parseSpec } from './spec';

export const QUESTION_STATUSES = ['open', 'answered', 'assumption'] as const;

export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

// Shortest snippet a repo citation may quote; anything shorter could match by accident.
export const MIN_SNIPPET_LENGTH = 8;

export type Citation =
  | { kind: 'repo'; file: string; start: number; end: number; snippet: string }
  | { kind: 'spec'; ac: string }
  | { kind: 'human'; question: string }
  | { kind: 'malformed'; raw: string };

export interface Fact {
  line: number;
  text: string;
  citations: Citation[];
}

export interface Question {
  id: string;
  text: string;
  line: number;
  status: string | null;
  answer: string | null;
  approved: boolean;
}

interface BadQuestion {
  title: string;
  line: number;
}

export interface Ledger {
  questions: Question[];
  facts: Fact[];
  badQuestions: BadQuestion[];
}

export type LedgerCode =
  | 'LEDGER_BAD_QUESTION_ID'
  | 'LEDGER_DUPLICATE_QUESTION'
  | 'LEDGER_BAD_STATUS'
  | 'LEDGER_NO_ANSWER'
  | 'LEDGER_UNCITED'
  | 'CITE_MALFORMED'
  | 'CITE_PATH_OUTSIDE_PROJECT'
  | 'CITE_SNIPPET_TOO_SHORT'
  | 'CITE_FILE_MISSING'
  | 'CITE_LINES_OUT_OF_RANGE'
  | 'CITE_SNIPPET_MISMATCH'
  | 'CITE_UNKNOWN_AC'
  | 'CITE_UNKNOWN_QUESTION'
  | 'CITE_OPEN_QUESTION'
  | 'CITE_UNAPPROVED_ASSUMPTION';

export interface LedgerError {
  code: LedgerCode;
  line: number;
  message: string;
}

const CITATION_START = /\[(repo|spec|human):/g;
const REPO_CITATION = /^\[repo:([^\s:\]]+):(\d+)(?:-(\d+))?\s+"((?:[^"\\]|\\.)*)"\]/;
const SPEC_CITATION = /^\[spec:(AC-\d+)\]/;
const HUMAN_CITATION = /^\[human:(Q\d+)\]/;
const QUESTION_HEADING = /^###\s+(Q\d+):\s*(.+?)\s*$/;
const QUESTION_FIELD = /^-\s+(Status|Answer|Approved):\s*(.*?)\s*$/i;
const CITATION_FORMAT =
  'Use [repo:<file>:<line>[-<line>] "<snippet>"], [spec:AC-<n>] or [human:Q<n>]';

function unescapeSnippet(snippet: string): string {
  return snippet.replace(/\\(.)/g, (_, char: string) => (char === 'n' ? '\n' : char));
}

// Reads every citation in a fact line, in order. A citation that starts like one but does
// not match its format is kept as "malformed" so it is reported instead of silently ignored.
function parseCitations(line: string): { text: string; citations: Citation[] } {
  const citations: Citation[] = [];
  let text = line;

  for (const start of line.matchAll(CITATION_START)) {
    const rest = line.slice(start.index);
    const repo = rest.match(REPO_CITATION);
    const spec = rest.match(SPEC_CITATION);
    const human = rest.match(HUMAN_CITATION);
    let raw: string;

    if (repo) {
      raw = repo[0];
      citations.push({
        kind: 'repo',
        file: repo[1],
        start: Number(repo[2]),
        end: Number(repo[3] ?? repo[2]),
        snippet: unescapeSnippet(repo[4]),
      });
    } else if (spec) {
      raw = spec[0];
      citations.push({ kind: 'spec', ac: spec[1] });
    } else if (human) {
      raw = human[0];
      citations.push({ kind: 'human', question: human[1] });
    } else {
      const close = rest.indexOf(']');
      raw = close === -1 ? rest : rest.slice(0, close + 1);
      citations.push({ kind: 'malformed', raw });
    }
    text = text.replace(raw, '');
  }

  return { text: text.replace(/\s+/g, ' ').trim(), citations };
}

export function parseLedger(text: string): Ledger {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const questions: Question[] = [];
  const badQuestions: BadQuestion[] = [];
  const facts: Fact[] = [];
  let section: 'questions' | 'facts' | null = null;
  let current: Question | null = null;

  lines.forEach((line, i) => {
    const lineNumber = i + 1;

    if (/^#{1,2}\s+/.test(line)) {
      const heading = line.replace(/^#{1,2}\s+/, '').trim().toLowerCase();
      section = heading === 'questions' ? 'questions' : heading === 'facts' ? 'facts' : null;
      current = null;
    } else if (section === 'questions' && /^###\s+/.test(line)) {
      const match = line.match(QUESTION_HEADING);
      if (match) {
        current = { id: match[1], text: match[2], line: lineNumber, status: null, answer: null, approved: false };
        questions.push(current);
      } else {
        badQuestions.push({ title: line.replace(/^###\s+/, '').trim(), line: lineNumber });
        current = null;
      }
    } else if (section === 'questions' && current) {
      const field = line.match(QUESTION_FIELD);
      if (!field) return;
      const value = field[2];
      const name = field[1].toLowerCase();
      if (name === 'status') current.status = value;
      else if (name === 'answer') current.answer = value || null;
      else current.approved = value.toLowerCase() === 'yes';
    } else if (section === 'facts' && /^-\s+/.test(line)) {
      facts.push({ line: lineNumber, ...parseCitations(line.replace(/^-\s+/, '')) });
    }
  });

  return { questions, facts, badQuestions };
}

function formatRange(start: number, end: number): string {
  return start === end ? `${start}` : `${start}-${end}`;
}

function readLines(file: string): string[] {
  const lines = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function checkRepoCitation(
  citation: Extract<Citation, { kind: 'repo' }>,
  projectRoot: string,
): { code: LedgerCode; message: string } | null {
  const { file, start, end, snippet } = citation;
  const root = path.resolve(projectRoot);
  const absolute = path.resolve(root, file);
  const relative = path.relative(root, absolute);

  if (path.isAbsolute(file) || relative.startsWith('..') || path.isAbsolute(relative)) {
    return { code: 'CITE_PATH_OUTSIDE_PROJECT', message: `${file} is outside the project` };
  }
  if (snippet.trim().length < MIN_SNIPPET_LENGTH) {
    return {
      code: 'CITE_SNIPPET_TOO_SHORT',
      message: `Snippet "${snippet}" is too short (at least ${MIN_SNIPPET_LENGTH} characters)`,
    };
  }
  if (!fs.existsSync(absolute)) {
    return { code: 'CITE_FILE_MISSING', message: `${file} does not exist` };
  }
  if (!fs.statSync(absolute).isFile()) {
    return { code: 'CITE_FILE_MISSING', message: `${file} is not a file` };
  }

  const range = formatRange(start, end);
  if (start < 1 || end < start) {
    return { code: 'CITE_LINES_OUT_OF_RANGE', message: `Invalid line range ${range} in ${file}` };
  }
  const lines = readLines(absolute);
  if (end > lines.length) {
    return {
      code: 'CITE_LINES_OUT_OF_RANGE',
      message: `${file} has ${lines.length} lines; cited ${range}`,
    };
  }
  if (!lines.slice(start - 1, end).join('\n').includes(snippet)) {
    return { code: 'CITE_SNIPPET_MISMATCH', message: `"${snippet}" is not in ${file}:${range}` };
  }
  return null;
}

// Checks that every fact in the ledger is backed by a source that really exists:
// code in the project, an acceptance criterion in the spec, or an answer from the human.
export function checkLedger(ledgerText: string, specText: string, projectRoot: string): LedgerError[] {
  const { questions, facts, badQuestions } = parseLedger(ledgerText);
  const acIds = new Set(parseSpec(specText).acceptanceCriteria.map((ac) => ac.id));
  const errors: LedgerError[] = [];
  const error = (code: LedgerCode, line: number, message: string) =>
    errors.push({ code, line, message });

  const byId = new Map<string, Question>();
  const headings = [
    ...questions.map((question) => ({ question, line: question.line })),
    ...badQuestions.map((bad) => ({ bad, line: bad.line })),
  ].sort((a, b) => a.line - b.line);

  for (const { question, bad, line } of headings as Array<{ question?: Question; bad?: BadQuestion; line: number }>) {
    if (bad) {
      error('LEDGER_BAD_QUESTION_ID', line, `Question "${bad.title}" does not match "### Q<n>: <question>"`);
      continue;
    }
    if (!question) continue;
    if (byId.has(question.id)) {
      error('LEDGER_DUPLICATE_QUESTION', line, `${question.id} is duplicated`);
      continue;
    }
    byId.set(question.id, question);

    if (!question.status) {
      error('LEDGER_BAD_STATUS', line, `${question.id} has no status. Use: ${QUESTION_STATUSES.join(', ')}`);
    } else if (!(QUESTION_STATUSES as readonly string[]).includes(question.status)) {
      error(
        'LEDGER_BAD_STATUS',
        line,
        `${question.id} has status "${question.status}". Use: ${QUESTION_STATUSES.join(', ')}`,
      );
    } else if (question.status !== 'open' && !question.answer) {
      error('LEDGER_NO_ANSWER', line, `${question.id} has no answer`);
    }
  }

  for (const fact of facts) {
    if (fact.citations.length === 0) {
      error('LEDGER_UNCITED', fact.line, `Fact has no citation: "${fact.text}"`);
      continue;
    }
    for (const citation of fact.citations) {
      if (citation.kind === 'malformed') {
        error('CITE_MALFORMED', fact.line, `Malformed citation ${citation.raw}. ${CITATION_FORMAT}`);
      } else if (citation.kind === 'repo') {
        const problem = checkRepoCitation(citation, projectRoot);
        if (problem) error(problem.code, fact.line, problem.message);
      } else if (citation.kind === 'spec') {
        if (!acIds.has(citation.ac)) error('CITE_UNKNOWN_AC', fact.line, `${citation.ac} is not in spec.md`);
      } else {
        const question = byId.get(citation.question);
        if (!question) {
          error('CITE_UNKNOWN_QUESTION', fact.line, `${citation.question} is not in the ledger`);
        } else if (question.status === 'assumption' && !question.approved) {
          error(
            'CITE_UNAPPROVED_ASSUMPTION',
            fact.line,
            `${question.id} is an assumption the human has not approved`,
          );
        } else if (question.status !== 'answered' && question.status !== 'assumption') {
          error('CITE_OPEN_QUESTION', fact.line, `${question.id} is still open`);
        }
      }
    }
  }

  return errors;
}
