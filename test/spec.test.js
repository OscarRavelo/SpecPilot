const fs = require('fs');
const path = require('path');
const { parseSpec, lintSpec } = require('../src/spec');

const fixture = (name) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'specs', name), 'utf8');

const codes = (errors) => errors.map((e) => e.code);

describe('parseSpec', () => {
  test('extrae id, tipo, título y criterios de aceptación', () => {
    const spec = parseSpec(fixture('valid.md'));

    expect(spec.id).toBe('TASK-101');
    expect(spec.type).toBe('endpoint-fields');
    expect(spec.title).toBe('Añadir campo phone a POST /users');
    expect(spec.acceptanceCriteria).toEqual([
      {
        id: 'AC-1',
        title: 'Guarda el teléfono cuando viene en el payload',
        line: 12,
        given: 'un payload válido con `phone: "+34600000000"`',
        when: 'se hace POST /users',
        then: 'responde 201 y el usuario guardado incluye `phone`',
      },
      {
        id: 'AC-2',
        title: 'Rechaza teléfonos con formato inválido',
        line: 17,
        given: 'un payload con `phone: "abc"`',
        when: 'se hace POST /users',
        then: 'responde 400 con `error.code = "INVALID_PHONE"`',
      },
    ]);
  });

  test('ignora encabezados ### fuera de la sección de criterios', () => {
    const text = fixture('valid.md').replace('## Contexto', '## Contexto\n\n### Nota');
    expect(parseSpec(text).acceptanceCriteria.map((ac) => ac.id)).toEqual(['AC-1', 'AC-2']);
    expect(lintSpec(text)).toEqual([]);
  });

  test('el título es el primer encabezado #', () => {
    const text = `${fixture('valid.md')}\n# Notas finales\n`;
    expect(parseSpec(text).title).toBe('Añadir campo phone a POST /users');
  });
});

describe('lintSpec', () => {
  test('una spec válida no tiene errores', () => {
    expect(lintSpec(fixture('valid.md'))).toEqual([]);
  });

  test('exige frontmatter', () => {
    expect(codes(lintSpec(fixture('no-frontmatter.md')))).toEqual(['SPEC_MISSING_FRONTMATTER']);
  });

  test('el frontmatter debe estar en la primera línea', () => {
    const text = `# Título\n---\nid: TASK-1\ntype: new-endpoint\n---\n${fixture('no-frontmatter.md')}`;
    expect(codes(lintSpec(text))).toEqual(['SPEC_MISSING_FRONTMATTER']);
  });

  test('un criterio duplicado solo reporta el duplicado', () => {
    const text = `${fixture('valid.md')}\n### AC-1: Repetido\n- Given algo\n`;
    expect(codes(lintSpec(text))).toEqual(['SPEC_DUPLICATE_AC']);
  });

  test('detecta todos los errores con su línea', () => {
    expect(lintSpec(fixture('invalid.md'))).toEqual([
      { code: 'SPEC_MISSING_ID', line: 1, message: 'Falta "id" en el frontmatter' },
      {
        code: 'SPEC_INVALID_TYPE',
        line: 2,
        message:
          'Tipo "microservice" no válido. Usa: new-endpoint, endpoint-fields, react-component',
      },
      { code: 'SPEC_DUPLICATE_AC', line: 13, message: 'AC-1 está duplicado' },
      {
        code: 'SPEC_AC_BAD_ID',
        line: 18,
        message: 'El criterio "Criterio sin id" no tiene formato "### AC-<n>: <título>"',
      },
      { code: 'SPEC_AC_INCOMPLETE', line: 23, message: 'AC-3 no tiene Then' },
    ]);
  });

  test('exige al menos un criterio de aceptación', () => {
    const text = '---\nid: TASK-1\ntype: new-endpoint\n---\n# Vacía\n';
    expect(codes(lintSpec(text))).toEqual(['SPEC_NO_AC']);
  });

  test('exige un título', () => {
    const text = fixture('valid.md').replace('# Añadir campo phone a POST /users\n', '');
    expect(codes(lintSpec(text))).toEqual(['SPEC_MISSING_TITLE']);
  });

  test('un criterio sin Given ni When reporta ambos', () => {
    const text = fixture('valid.md').replace(
      '- Given un payload con `phone: "abc"`\n- When se hace POST /users\n',
      '',
    );
    expect(lintSpec(text).map((e) => e.message)).toEqual([
      'AC-2 no tiene Given',
      'AC-2 no tiene When',
    ]);
  });

  test('la plantilla publicada pasa el lint', () => {
    const template = fs.readFileSync(
      path.join(__dirname, '..', 'templates', 'spec.md'),
      'utf8',
    );
    expect(lintSpec(template)).toEqual([]);
  });
});
