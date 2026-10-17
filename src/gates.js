const fs = require('fs');
const path = require('path');
const { parseSpec, lintSpec } = require('./spec');

const pass = () => ({ ok: true, reasons: [] });
const fail = (...reasons) => ({ ok: false, reasons });

function researchGate(taskDir) {
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

const GATES = {
  research: researchGate,
};

// Checks whether the current phase can be closed. A phase without an implemented gate never passes.
function runGate(taskDir, phase) {
  if (phase === 'done') return fail('The task is already done');
  const gate = GATES[phase];
  if (!gate) return fail(`The ${phase} gate is not implemented yet`);
  return gate(taskDir);
}

module.exports = { runGate };
