import crypto from 'crypto';

export interface Audit {
  hash: string | null;
  // null when the Blockers section is missing or empty; [] only for an explicit "- none".
  blockers: string[] | null;
}

const normalize = (text: string) => text.replace(/\r\n/g, '\n');

// Ties an audit to the exact spec and ledger it reviewed: editing either one invalidates it.
export function ledgerHash(specText: string, ledgerText: string): string {
  return crypto
    .createHash('sha256')
    .update(`${normalize(specText)}\0${normalize(ledgerText)}`)
    .digest('hex');
}

export function parseAudit(text: string): Audit {
  const lines = normalize(text).split('\n');
  const hashMatch = text.match(/^Ledger hash:\s*([0-9a-f]{64})\s*$/m);
  let inBlockers = false;
  let hasSection = false;
  const bullets: string[] = [];

  for (const line of lines) {
    if (/^#{1,2}\s+/.test(line)) {
      inBlockers = /^##\s+Blockers\s*$/i.test(line);
      hasSection = hasSection || inBlockers;
    } else if (inBlockers && /^-\s+/.test(line)) {
      bullets.push(line.replace(/^-\s+/, '').trim());
    }
  }

  const blockers = bullets.filter((bullet) => bullet.toLowerCase() !== 'none');
  return {
    hash: hashMatch ? hashMatch[1] : null,
    blockers: !hasSection || bullets.length === 0 ? null : blockers,
  };
}
