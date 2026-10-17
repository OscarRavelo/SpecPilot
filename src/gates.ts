import fs from 'fs';
import path from 'path';
import { parseSpec, lintSpec } from './spec';
import type { Phase } from './state';

export interface GateResult {
  ok: boolean;
  reasons: string[];
}

type Gate = (taskDir: string) => GateResult;

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

const GATES: Partial<Record<Phase, Gate>> = {
  research: researchGate,
};

// Checks whether the current phase can be closed. A phase without an implemented gate never passes.
export function runGate(taskDir: string, phase: Phase): GateResult {
  if (phase === 'done') return fail('The task is already done');
  const gate = GATES[phase];
  if (!gate) return fail(`The ${phase} gate is not implemented yet`);
  return gate(taskDir);
}
