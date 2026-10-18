import fs from 'fs';
import path from 'path';
import { parseSpec, lintSpec } from './spec';
import { checklistFor } from './checklist';
import { checkLedger, parseLedger } from './ledger';
import { ledgerHash, parseAudit } from './audit';
import { hashChanges, readEvidence, testFileHashes } from './tdd';
import type { Phase } from './state';

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

type Gate = (taskDir: string, projectRoot: string) => GateResult;

const pass = (): GateResult => ({ ok: true, reasons: [] });
const fail = (...reasons: string[]): GateResult => ({ ok: false, reasons });

function researchGate(taskDir: string): GateResult {
  const file = path.join(taskDir, 'spec.md');
  if (!fs.existsSync(file)) return fail(`Missing ${file}`);

  const text = fs.readFileSync(file, 'utf8');
  const errors = lintSpec(text);
  if (errors.length > 0) {
    return fail(...errors.map(({ code, line, message }) => `spec.md:${line} ${code} ${message}`));
  }

  const { id } = parseSpec(text);
  const folder = path.basename(taskDir);
  if (id !== folder) {
    return fail(`Spec id (${id}) does not match its folder (${folder})`);
  }
  return pass();
}

// The grill phase closes only when every checklist item and acceptance criterion is backed
// by a verified citation, nothing is still open, and a clean-context audit of exactly this
// spec and ledger found no blockers.
function grillGate(taskDir: string, projectRoot: string): GateResult {
  const research = researchGate(taskDir);
  if (!research.ok) return research;

  const ledgerFile = path.join(taskDir, 'grill.md');
  if (!fs.existsSync(ledgerFile)) return fail(`Missing ${ledgerFile}`);

  const specText = fs.readFileSync(path.join(taskDir, 'spec.md'), 'utf8');
  const ledgerText = fs.readFileSync(ledgerFile, 'utf8');
  const spec = parseSpec(specText);
  const ledger = parseLedger(ledgerText);
  const reasons = checkLedger(ledgerText, specText, projectRoot).map(
    ({ code, line, message }) => `grill.md:${line} ${code} ${message}`,
  );

  for (const question of ledger.questions) {
    if (question.status === 'open') reasons.push(`${question.id} is still open: ${question.text}`);
  }

  const covered = new Set(ledger.facts.flatMap((fact) => fact.topics));
  for (const item of checklistFor(spec.type as string)) {
    if (!covered.has(item.id)) {
      reasons.push(`Checklist item not covered: ${item.id} (${item.description})`);
    }
  }

  const citedAcs = new Set(
    ledger.facts.flatMap((fact) =>
      fact.citations.flatMap((citation) => (citation.kind === 'spec' ? [citation.ac] : [])),
    ),
  );
  for (const ac of spec.acceptanceCriteria) {
    if (!citedAcs.has(ac.id)) reasons.push(`${ac.id} is not cited by any fact`);
  }

  const auditFile = path.join(taskDir, 'audit.md');
  if (!fs.existsSync(auditFile)) {
    reasons.push('Missing audit.md: run the grill-auditor subagent');
  } else {
    const audit = parseAudit(fs.readFileSync(auditFile, 'utf8'));
    if (audit.hash !== ledgerHash(specText, ledgerText)) {
      reasons.push(
        'audit.md is stale: spec.md or grill.md changed after the audit. Run the grill-auditor subagent again',
      );
    } else if (audit.blockers === null) {
      reasons.push('audit.md must list its blockers under "## Blockers", or "- none"');
    } else {
      for (const blocker of audit.blockers) reasons.push(`Auditor blocker: ${blocker}`);
    }
  }

  return reasons.length === 0 ? pass() : fail(...reasons);
}

// Red closes only if tdd red saw the tests fail on assertions and the tests have not changed since.
function redGate(taskDir: string, projectRoot: string): GateResult {
  const taskId = path.basename(taskDir);
  const red = readEvidence(taskDir, 'red');
  if (!red) return fail(`Missing red.json: run specpilot tdd red ${taskId}`);
  const changes = hashChanges(red.testFiles, testFileHashes(projectRoot));
  if (changes.length > 0) {
    return fail(`Tests changed after tdd red (${changes.join(', ')}): run specpilot tdd red ${taskId} again`);
  }
  return pass();
}

// Green closes only if tdd green saw every test pass, with exactly the tests that were red.
function greenGate(taskDir: string, projectRoot: string): GateResult {
  const taskId = path.basename(taskDir);
  const red = readEvidence(taskDir, 'red');
  if (!red) return fail(`Missing red.json: run specpilot tdd red ${taskId}`);
  const green = readEvidence(taskDir, 'green');
  if (!green) return fail(`Missing green.json: run specpilot tdd green ${taskId}`);

  const sinceGreen = hashChanges(green.testFiles, testFileHashes(projectRoot));
  if (sinceGreen.length > 0) {
    return fail(`Tests changed after tdd green (${sinceGreen.join(', ')}): run specpilot tdd green ${taskId} again`);
  }
  const redToGreen = hashChanges(red.testFiles, green.testFiles);
  if (redToGreen.length > 0) {
    return fail(
      `Tests changed between tdd red and tdd green (${redToGreen.join(', ')}): go back with specpilot reopen ${taskId} red`,
    );
  }
  return pass();
}

const GATES: Partial<Record<Phase, Gate>> = {
  research: researchGate,
  grill: grillGate,
  red: redGate,
  green: greenGate,
};

// Checks whether the current phase can be closed. A phase without an implemented gate never passes.
export function runGate(taskDir: string, phase: Phase, projectRoot: string = process.cwd()): GateResult {
  if (phase === 'done') return fail('The task is already done');
  const gate = GATES[phase];
  if (!gate) return fail(`The ${phase} gate is not implemented yet`);
  try {
    return gate(taskDir, projectRoot);
  } catch (err) {
    return fail((err as Error).message);
  }
}
