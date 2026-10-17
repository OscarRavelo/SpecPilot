const TASK_TYPES = ['new-endpoint', 'endpoint-fields', 'react-component'];
const AC_SECTION = /^##\s+Acceptance criteria\s*$/i;
const AC_HEADING = /^###\s+(AC-\d+):\s*(.+?)\s*$/;
const STEP = /^-\s+(Given|When|Then|And)\s+(.+?)\s*$/;

function parseFrontmatter(lines) {
  if (lines[0] !== '---') return null;
  const end = lines.indexOf('---', 1);
  if (end === -1) return null;

  const fields = {};
  for (let i = 1; i < end; i++) {
    const match = lines[i].match(/^(\w+):\s*(.*?)\s*$/);
    if (match) fields[match[1]] = { value: match[2], line: i + 1 };
  }
  return { fields, end };
}

// Walks the spec once and returns both the parsed result and the raw data lint needs.
function scan(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const frontmatter = parseFrontmatter(lines);
  const criteria = [];
  const badHeadings = [];
  let title = null;
  let inAcSection = false;
  let current = null;

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
        const kind = step[1] === 'And' ? current.lastStep : step[1].toLowerCase();
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

function parseSpec(text) {
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

function lintSpec(text) {
  const { frontmatter, title, criteria, badHeadings } = scan(text);
  const errors = [];
  const error = (code, line, message) => errors.push({ code, line, message });

  if (!frontmatter) {
    error('SPEC_MISSING_FRONTMATTER', 1, 'Missing frontmatter (--- id / type ---)');
  } else {
    const { id, type } = frontmatter.fields;
    if (!id || !id.value) error('SPEC_MISSING_ID', 1, 'Missing "id" in frontmatter');
    if (!type || !type.value) {
      error('SPEC_MISSING_TYPE', 1, `Missing "type" in frontmatter. Use: ${TASK_TYPES.join(', ')}`);
    } else if (!TASK_TYPES.includes(type.value)) {
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

  const seen = new Set();
  const findings = [
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
    if (seen.has(ac.id)) {
      error('SPEC_DUPLICATE_AC', line, `${ac.id} is duplicated`);
      continue;
    }
    seen.add(ac.id);
    for (const step of ['given', 'when', 'then']) {
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

module.exports = { TASK_TYPES, parseSpec, lintSpec };
