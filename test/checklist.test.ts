import { CHECKLISTS, checklistFor } from '../src/checklist';
import { TASK_TYPES } from '../src/spec';

describe('checklists', () => {
  test('every task type has a checklist', () => {
    expect(Object.keys(CHECKLISTS).sort()).toEqual([...TASK_TYPES].sort());
  });

  test.each([...TASK_TYPES])('%s items have unique kebab-case ids and a description', (type) => {
    const items = checklistFor(type);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    for (const item of items) {
      expect(item.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(item.description.length).toBeGreaterThan(10);
    }
  });

  test.each([
    ['new-endpoint', ['contract', 'validation', 'errors', 'data', 'auth', 'edge-cases', 'out-of-scope']],
    [
      'endpoint-fields',
      ['contract', 'validation', 'errors', 'data', 'auth', 'compatibility', 'edge-cases', 'out-of-scope'],
    ],
    [
      'react-component',
      [
        'contract',
        'states',
        'data',
        'validation',
        'errors',
        'auth',
        'accessibility',
        'compatibility',
        'edge-cases',
        'out-of-scope',
      ],
    ],
  ])('%s covers the expected items', (type, ids) => {
    expect(checklistFor(type).map((item) => item.id)).toEqual(ids);
  });

  test('an unknown task type fails', () => {
    expect(() => checklistFor('microservice')).toThrow('Unknown task type: microservice');
  });
});
