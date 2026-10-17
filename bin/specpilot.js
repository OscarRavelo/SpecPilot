#!/usr/bin/env node
const fs = require('fs');
const { parseSpec, lintSpec } = require('../src/spec');

const HELP = `Uso: specpilot <comando> [opciones]

Comandos:
  init                 Instala SpecPilot en el proyecto actual
  spec lint <fichero>  Valida el formato de una spec
  status               Muestra la fase de cada tarea
  gate <fase>          Comprueba si una fase puede cerrarse
  tdd red|green        Registra la evidencia de rojo / verde
  mutate               Inyecta bugs y comprueba que los tests fallan
  verify               Verifica la tarea contra la spec
  report               Resume métricas de coste y calidad
`;

const NOT_IMPLEMENTED = ['init', 'status', 'gate', 'tdd', 'mutate', 'verify', 'report'];

function specLint(file) {
  if (!file) {
    console.error('Uso: specpilot spec lint <fichero>');
    return 1;
  }

  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.error(`No se puede leer ${file}: ${err.message}`);
    return 1;
  }

  const errors = lintSpec(text);
  if (errors.length === 0) {
    const spec = parseSpec(text);
    console.log(`OK: ${spec.id} (${spec.acceptanceCriteria.length} criterios de aceptación)`);
    return 0;
  }

  for (const { code, line, message } of errors) {
    console.error(`${file}:${line} ${code} ${message}`);
  }
  console.error(`${errors.length} ${errors.length === 1 ? 'error' : 'errores'}`);
  return 1;
}

function main([command, ...args]) {
  if (command === '--help' || command === '-h') {
    console.log(HELP);
    return 0;
  }
  if (!command) {
    console.log(HELP);
    return 1;
  }
  if (command === 'spec' && args[0] === 'lint') return specLint(args[1]);
  if (NOT_IMPLEMENTED.includes(command)) {
    console.error(`"${command}" aún no está implementado`);
    return 1;
  }
  console.error(`Comando desconocido: ${command}`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));
