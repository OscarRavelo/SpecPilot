import crypto from 'crypto';
import { ledgerHash, parseAudit } from '../src/audit';

const sha256 = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

describe('ledgerHash', () => {
  test('is the sha256 of the spec and the ledger joined by a NUL byte', () => {
    expect(ledgerHash('spec', 'ledger')).toBe(sha256('spec\0ledger'));
  });

  test('ignores CRLF vs LF line endings', () => {
    expect(ledgerHash('a\r\nb', 'c\r\nd')).toBe(ledgerHash('a\nb', 'c\nd'));
  });

  test('changes when either file changes', () => {
    const base = ledgerHash('spec', 'ledger');
    expect(ledgerHash('spec!', 'ledger')).not.toBe(base);
    expect(ledgerHash('spec', 'ledger!')).not.toBe(base);
    expect(ledgerHash('spe', 'cledger')).not.toBe(base);
  });
});

describe('parseAudit', () => {
  const HASH = 'a'.repeat(64);

  test('reads the hash and an explicit "none" as no blockers', () => {
    const text = `# Grill audit: TASK-1\n\nLedger hash: ${HASH}\n\n## Blockers\n\n- none\n`;
    expect(parseAudit(text)).toEqual({ hash: HASH, blockers: [] });
  });

  test('reads each blocker', () => {
    const text = `Ledger hash: ${HASH}\n\n## Blockers\n\n- AC-1 does not say what happens on 404\n- No fact covers rate limits\n`;
    expect(parseAudit(text)).toEqual({
      hash: HASH,
      blockers: ['AC-1 does not say what happens on 404', 'No fact covers rate limits'],
    });
  });

  test('an empty Blockers section is not the same as "none"', () => {
    expect(parseAudit(`Ledger hash: ${HASH}\n\n## Blockers\n`)).toEqual({ hash: HASH, blockers: null });
  });

  test('"none" together with blockers keeps the blockers', () => {
    expect(parseAudit(`Ledger hash: ${HASH}\n\n## Blockers\n\n- none\n- Missing 404 case\n`)).toEqual({
      hash: HASH,
      blockers: ['Missing 404 case'],
    });
  });

  test('missing hash and missing Blockers section are null', () => {
    expect(parseAudit('# Grill audit\n')).toEqual({ hash: null, blockers: null });
  });

  test('bullets outside the Blockers section are ignored', () => {
    const text = `Ledger hash: ${HASH}\n\n## Notes\n\n- looks fine\n\n## Blockers\n\n- none\n`;
    expect(parseAudit(text)).toEqual({ hash: HASH, blockers: [] });
  });

  test('a section after Blockers ends it', () => {
    const text = `Ledger hash: ${HASH}\n\n## Blockers\n\n- none\n\n## Notes\n\n- looks fine\n`;
    expect(parseAudit(text)).toEqual({ hash: HASH, blockers: [] });
  });

  test('"None" is matched case-insensitively', () => {
    expect(parseAudit(`Ledger hash: ${HASH}\n\n## Blockers\n\n- None\n`)).toEqual({ hash: HASH, blockers: [] });
  });
});
