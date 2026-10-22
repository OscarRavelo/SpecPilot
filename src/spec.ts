export const TASK_TYPES = ['new-endpoint', 'endpoint-fields', 'react-component', 'cli-command'] as const;

export type StepKind = 'given' | 'when' | 'then';

export interface AcceptanceCriterion {
  id: string;
  title: string;
  line: number;
  given: string[];
  when: string[];
  then: string[];
}

export interface Spec {
  id: string | null;
  type: string | null;
  title: string | null;
  acceptanceCriteria: AcceptanceCriterion[];
}

export type LintCode =
  | 'SPEC_MISSING_FRONTMATTER'
  | 'SPEC_MISSING_ID'
  | 'SPEC_MISSING_TYPE'
  | 'SPEC_INVALID_TYPE'
  | 'SPEC_MISSING_TITLE'
  | 'SPEC_NO_AC'
  | 'SPEC_AC_BAD_ID'
  | 'SPEC_DUPLICATE_AC'
  | 'SPEC_AC_INCOMPLETE'
  | 'SPEC_AC_ORPHAN_AND';

export interface LintError {
  code: LintCode;
  line: number;
  message: string;
}

interface FrontmatterField {
  value: string;
  line: number;
}

interface Frontmatter {
  fields: Record<string, FrontmatterField>;
  end: number;
}

interface ScannedCriterion extends Partial<Record<StepKind, string[]>> {
  id: string;
  title: string;
  line: number;
  lastStep: StepKind | null;
  orphanAnds: number[];
}

interface BadHeading {
  title: string;
  line: number;
}

interface Scan {
  frontmatter: Frontmatter | null;
  title: string | null;
  criteria: ScannedCriterion[];
  badHeadings: BadHeading[];
}

const STEP_KINDS: StepKind[] = ['given', 'when', 'then'];
const AC_SECTION = /^##\s+Acceptance criteria\s*$/i;
const AC_HEADING = /^###\s+(AC-\d+):\s*(.+?)\s*$/;
const STEP = /^-\s+(Given|When|Then|And)\s+(.+?)\s*$/;

function parseFrontmatter(lines: string[]): Frontmatter | null {
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;

  const fields: Record<string, FrontmatterField> = {};
  for (let i = 1; i < end; i++) {
    const match = lines[i].match(/^(\w+):\s*(.*?)\s*$/);
    if (match) fields[match[1]] = { value: match[2], line: i + 1 };
  }
  return { fields, end };
}

// Walks the spec once and returns both the parsed result and the raw data lint needs.
function scan(text: string): Scan {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const frontmatter = parseFrontmatter(lines);
  const criteria: ScannedCriterion[] = [];
  const badHeadings: BadHeading[] = [];
  let title: string | null = null;
  let inAcSection = false;
  let current: ScannedCriterion | null = null;

  for (let i = frontmatter ? frontmatter.end + 1 : 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNumber = i + 1;

    if (/^#\s+/.test(line)) {
      if (title === null) title = line.replace(/^#\s+/, '').trim();
      inAcSection = false;
      current = null;
    } else if (/^##\s+/.test(line)) {
      inAcSection = AC_SECTION.test(line);
      current = null;
    } else if (inAcSection && /^###\s+/.test(line)) {
      const match = line.match(AC_HEADING);
      if (match) {
        current = { id: match[1], title: match[2], line: lineNumber, lastStep: null, orphanAnds: [] };
        criteria.push(current);
      } else {
        badHeadings.push({ title: line.replace(/^###\s+/, '').trim(), line: lineNumber });
        current = null;
      }
    } else if (current) {
      const step = line.match(STEP);
      if (step) {
        // "And" continues whichever step came before it: Given → Given, Then → Then.
        const kind = step[1] === 'And' ? current.lastStep : (step[1].toLowerCase() as StepKind);
        if (kind) {
          current[kind] = [...(current[kind] || []), step[2]];
          current.lastStep = kind;
        } else {
          current.orphanAnds.push(lineNumber);
        }
      }
    }
  }

  return { frontmatter, title, criteria, badHeadings };
}

export function parseSpec(text: string): Spec {
  const { frontmatter, title, criteria } = scan(text);
  const fields = frontmatter ? frontmatter.fields : {};

  return {
    id: fields.id ? fields.id.value : null,
    type: fields.type ? fields.type.value : null,
    title,
    acceptanceCriteria: criteria.map((ac) => ({
      id: ac.id,
      title: ac.title,
      line: ac.line,
      given: ac.given || [],
      when: ac.when || [],
      then: ac.then || [],
    })),
  };
}

export function lintSpec(text: string): LintError[] {
  const { frontmatter, title, criteria, badHeadings } = scan(text);
  const errors: LintError[] = [];
  const error = (code: LintCode, line: number, message: string) =>
    errors.push({ code, line, message });

  if (!frontmatter) {
    error('SPEC_MISSING_FRONTMATTER', 1, 'Missing frontmatter (--- id / type ---)');
  } else {
    const { id, type } = frontmatter.fields;
    if (!id || !id.value) error('SPEC_MISSING_ID', 1, 'Missing "id" in frontmatter');
    if (!type || !type.value) {
      error('SPEC_MISSING_TYPE', 1, `Missing "type" in frontmatter. Use: ${TASK_TYPES.join(', ')}`);
    } else if (!(TASK_TYPES as readonly string[]).includes(type.value)) {
      error(
        'SPEC_INVALID_TYPE',
        type.line,
        `Invalid type "${type.value}". Use: ${TASK_TYPES.join(', ')}`,
      );
    }
  }

  if (title === null) error('SPEC_MISSING_TITLE', 1, 'Missing title (# Title)');

  if (criteria.length === 0 && badHeadings.length === 0) {
    error('SPEC_NO_AC', 1, 'No acceptance criteria (## Acceptance criteria / ### AC-1: ...)');
  }

  const seen = new Set<string>();
  const findings: Array<{ ac?: ScannedCriterion; bad?: BadHeading; line: number }> = [
    ...criteria.map((ac) => ({ ac, line: ac.line })),
    ...badHeadings.map((bad) => ({ bad, line: bad.line })),
  ].sort((a, b) => a.line - b.line);

  for (const { ac, bad, line } of findings) {
    if (bad) {
      error(
        'SPEC_AC_BAD_ID',
        line,
        `Criterion "${bad.title}" does not match "### AC-<n>: <title>"`,
      );
      continue;
    }
    if (!ac) continue;
    if (seen.has(ac.id)) {
      error('SPEC_DUPLICATE_AC', line, `${ac.id} is duplicated`);
      continue;
    }
    seen.add(ac.id);
    for (const step of STEP_KINDS) {
      if (!ac[step]) {
        const name = step[0].toUpperCase() + step.slice(1);
        error('SPEC_AC_INCOMPLETE', line, `${ac.id} has no ${name}`);
      }
    }
    for (const andLine of ac.orphanAnds) {
      error('SPEC_AC_ORPHAN_AND', andLine, `${ac.id}: "And" has no previous Given/When/Then to continue`);
    }
  }

  return errors;
}
