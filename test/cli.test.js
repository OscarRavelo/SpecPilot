const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin', 'specpilot.js');
const SPECS = path.join(__dirname, 'fixtures', 'specs');

const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

describe('specpilot CLI', () => {
  test('--help lista los comandos de v0.1', () => {
    const result = run('--help');

    expect(result.status).toBe(0);
    for (const command of ['init', 'spec lint', 'gate', 'tdd', 'mutate', 'verify', 'report', 'status']) {
      expect(result.stdout).toContain(command);
    }
  });

  test('sin argumentos muestra la ayuda y sale con 1', () => {
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Uso: specpilot');
  });

  test('un comando desconocido sale con 1', () => {
    const result = run('volar');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Comando desconocido: volar');
  });

  test('un comando aún no implementado lo dice y sale con 1', () => {
    const result = run('verify');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('"verify" aún no está implementado');
  });

  test('spec lint de una spec válida sale con 0', () => {
    const result = run('spec', 'lint', path.join(SPECS, 'valid.md'));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('OK: TASK-101 (2 criterios de aceptación)');
  });

  test('spec lint de una spec inválida lista errores con fichero:línea y sale con 1', () => {
    const file = path.join(SPECS, 'invalid.md');
    const result = run('spec', 'lint', file);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${file}:13 SPEC_DUPLICATE_AC AC-1 está duplicado`);
    expect(result.stderr).toContain('5 errores');
  });

  test('spec lint sin fichero sale con 1', () => {
    const result = run('spec', 'lint');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Uso: specpilot spec lint <fichero>');
  });

  test('spec lint con fichero inexistente sale con 1', () => {
    const result = run('spec', 'lint', path.join(SPECS, 'no-existe.md'));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('No se puede leer');
  });
});
