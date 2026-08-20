import { describe, it, expect } from 'vitest';
import { redactSecrets } from '../../src/utils/redact-secrets.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

/** Builds a string of `char` repeated `n` times. */
const repeat = (char: string, n: number): string => char.repeat(n);

// ─── Pattern 1 — GitHub PAT classic (ghp_) ───────────────────────────────────

describe('Pattern 1 — GitHub PAT classic (ghp_)', () => {
  it('redacts a minimal-length GitHub PAT classic token (36 chars after prefix)', () => {
    const token = `ghp_${repeat('a', 36)}`;
    expect(redactSecrets(`Authorization: token ${token}`)).toBe(
      'Authorization: token [REDACTED]',
    );
  });

  it('redacts a longer GitHub PAT classic token (50 chars after prefix)', () => {
    const token = `ghp_${repeat('Z', 50)}`;
    expect(redactSecrets(token)).toBe('[REDACTED]');
  });

  it('does NOT redact a ghp_ token with only 35 chars after the prefix (below minimum)', () => {
    const token = `ghp_${repeat('a', 35)}`;
    // Pattern 1 requires {36,}; 35 chars is too short.
    // Pattern 6 also cannot match because no continuous 40-char alphanum run exists:
    //   "ghp" (3 chars) stops at "_", remaining 35 chars < 40.
    expect(redactSecrets(token)).toBe(token);
  });

  it('redacts all occurrences when multiple ghp_ tokens appear in one string', () => {
    const t1 = `ghp_${repeat('a', 36)}`;
    const t2 = `ghp_${repeat('b', 36)}`;
    const input = `first=${t1} second=${t2}`;
    expect(redactSecrets(input)).toBe('first=[REDACTED] second=[REDACTED]');
  });
});

// ─── Pattern 2 — GitHub Apps token (ghs_) ────────────────────────────────────

describe('Pattern 2 — GitHub Apps token (ghs_)', () => {
  it('redacts a minimal-length GitHub Apps token (36 chars after prefix)', () => {
    const token = `ghs_${repeat('A', 36)}`;
    expect(redactSecrets(`x-token: ${token}`)).toBe('x-token: [REDACTED]');
  });

  it('redacts a longer GitHub Apps token', () => {
    const token = `ghs_${repeat('x', 60)}`;
    expect(redactSecrets(token)).toBe('[REDACTED]');
  });

  it('does NOT redact a ghs_ token with 35 chars (below minimum)', () => {
    const token = `ghs_${repeat('A', 35)}`;
    expect(redactSecrets(token)).toBe(token);
  });
});

// ─── Pattern 3 — GitHub fine-grained PAT (github_pat_) ───────────────────────

describe('Pattern 3 — GitHub fine-grained PAT (github_pat_)', () => {
  it('redacts a minimal-length fine-grained PAT (36 chars after prefix)', () => {
    const token = `github_pat_${repeat('c', 36)}`;
    expect(redactSecrets(`token=${token}`)).toBe('token=[REDACTED]');
  });

  it('redacts a fine-grained PAT that includes underscores in the payload', () => {
    // The character class for github_pat_ is [A-Za-z0-9_]
    const token = `github_pat_${'Ab1_'.repeat(10)}`; // 40 chars after prefix
    expect(redactSecrets(token)).toBe('[REDACTED]');
  });

  it('does NOT redact github_pat_ with 35-char payload (below minimum)', () => {
    const token = `github_pat_${repeat('c', 35)}`;
    expect(redactSecrets(token)).toBe(token);
  });
});

// ─── Pattern 4 — Confluence / Atlassian API token (ATATT) ────────────────────

describe('Pattern 4 — Confluence/Atlassian API token (ATATT)', () => {
  it('redacts a minimal-length Confluence token (20 chars after ATATT)', () => {
    const token = `ATATT${repeat('d', 20)}`;
    expect(redactSecrets(`confluence_token=${token}`)).toBe(
      'confluence_token=[REDACTED]',
    );
  });

  it('redacts a Confluence token that includes +, /, =, _ and - characters', () => {
    // The char class is [A-Za-z0-9+/=_-]
    const payload = 'AbCdEfGhIj+Kl/Mn=Op_Qr-StUvWx'; // 30 chars, all valid
    const token = `ATATT${payload}`;
    expect(redactSecrets(token)).toBe('[REDACTED]');
  });

  it('does NOT redact an ATATT token with only 19-char payload (below minimum)', () => {
    const token = `ATATT${repeat('d', 19)}`;
    expect(redactSecrets(token)).toBe(token);
  });
});

// ─── Pattern 5 — Generic Bearer token ────────────────────────────────────────

describe('Pattern 5 — Generic Bearer token', () => {
  it('redacts a minimal Bearer token value (20 chars)', () => {
    const value = repeat('e', 20);
    expect(redactSecrets(`Authorization: Bearer ${value}`)).toBe(
      'Authorization: [REDACTED]',
    );
  });

  it('redacts a Bearer token with dot-separated JWT-like value', () => {
    // JWTs contain dots; [A-Za-z0-9._-] includes dots
    const header = repeat('A', 20);
    const payload = repeat('B', 20);
    const sig = repeat('C', 20);
    const jwt = `${header}.${payload}.${sig}`;
    expect(redactSecrets(`Bearer ${jwt}`)).toBe('[REDACTED]');
  });

  it('redacts a Bearer token with multiple spaces (\\s+)', () => {
    const value = repeat('f', 25);
    // \s+ matches one or more whitespace characters
    expect(redactSecrets(`Bearer  ${value}`)).toBe('[REDACTED]');
  });

  it('does NOT redact a Bearer value with only 19 chars (below minimum)', () => {
    const value = repeat('e', 19);
    const input = `Authorization: Bearer ${value}`;
    // 19 chars < 20-char minimum; pattern 5 does not match.
    // Pattern 6 also won't match: the alphanumeric run between "Bearer " and end
    // is only 19 chars, well below 40.
    expect(redactSecrets(input)).toBe(input);
  });
});

// ─── Pattern 6 — Generic Base64 blob ≥ 40 chars ──────────────────────────────

describe('Pattern 6 — Generic Base64 blob (≥ 40 chars)', () => {
  it('redacts a 40-char Base64 string without padding', () => {
    // Exactly 40 chars from [A-Za-z0-9+/] — meets the {40,} minimum.
    const blob = repeat('g', 40);
    expect(redactSecrets(blob)).toBe('[REDACTED]');
  });

  it('redacts a Base64 blob with = padding', () => {
    const blob = `${repeat('h', 40)}=`;
    expect(redactSecrets(blob)).toBe('[REDACTED]');
  });

  it('redacts a Base64 blob with == padding', () => {
    const blob = `${repeat('i', 40)}==`;
    expect(redactSecrets(blob)).toBe('[REDACTED]');
  });

  it('redacts a realistic Base64-encoded value', () => {
    // "dGVzdHRva2VudGVzdHRva2VudGVzdHRva2VudGVzdA==" is 42 base64 chars + "=="
    const blob = 'dGVzdHRva2VudGVzdHRva2VudGVzdHRva2VudGVzdA==';
    expect(redactSecrets(blob)).toBe('[REDACTED]');
  });

  it('does NOT redact a 39-char alphanum sequence (below minimum)', () => {
    const short = repeat('j', 39);
    expect(redactSecrets(short)).toBe(short);
  });

  it('does NOT redact tokens whose continuous alphanum run is broken into short segments', () => {
    // Spaces break the run; no individual run is ≥ 40 chars.
    const input = `${repeat('k', 20)} ${repeat('l', 20)}`;
    expect(redactSecrets(input)).toBe(input);
  });
});

// ─── Multi-pattern: multiple distinct secrets in one string ──────────────────

describe('Multiple distinct secret patterns in one string', () => {
  it('redacts all matching patterns when multiple different secret types appear', () => {
    const ghPat = `ghp_${repeat('a', 36)}`;        // pattern 1
    const ghsToken = `ghs_${repeat('B', 36)}`;     // pattern 2
    const atlToken = `ATATT${repeat('c', 25)}`;    // pattern 4

    const input = `pat=${ghPat} ghs=${ghsToken} atl=${atlToken}`;
    expect(redactSecrets(input)).toBe(
      'pat=[REDACTED] ghs=[REDACTED] atl=[REDACTED]',
    );
  });

  it('redacts a github_pat_ token and a Bearer token appearing together', () => {
    const finePat = `github_pat_${repeat('D', 36)}`; // pattern 3
    const bearer = `Bearer ${repeat('e', 30)}`;        // pattern 5

    const input = `fine_pat=${finePat} auth=${bearer}`;
    expect(redactSecrets(input)).toBe(
      'fine_pat=[REDACTED] auth=[REDACTED]',
    );
  });

  it('redacts all six pattern families when all appear in one string', () => {
    const p1 = `ghp_${repeat('a', 36)}`;
    const p2 = `ghs_${repeat('B', 36)}`;
    const p3 = `github_pat_${repeat('c', 36)}`;
    const p4 = `ATATT${repeat('d', 20)}`;
    const p5bearer = `Bearer ${repeat('e', 20)}`;
    // Pattern 6: a 40-char base64 blob that doesn't match patterns 1–5.
    // Using 'f' repeated 40 times — no named prefix.
    const p6 = repeat('f', 40);

    const input = [p1, p2, p3, p4, p5bearer, p6].join(' | ');
    const output = redactSecrets(input);

    // Every original secret value must be absent in the output.
    expect(output).not.toContain(p1);
    expect(output).not.toContain(p2);
    expect(output).not.toContain(p3);
    expect(output).not.toContain(p4);
    // Bearer value alone (p5bearer starts with "Bearer ")
    expect(output).not.toContain(repeat('e', 20));
    expect(output).not.toContain(p6);

    // All six slots replaced with [REDACTED]
    const redactedCount = (output.match(/\[REDACTED\]/g) ?? []).length;
    expect(redactedCount).toBe(6);
  });
});

// ─── Passthrough — no secrets ─────────────────────────────────────────────────

describe('Passthrough — strings with no secrets', () => {
  it('returns an empty string unchanged', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('returns a plain English sentence byte-for-byte unchanged', () => {
    const input = 'Hello, world! This is a normal string without any secrets.';
    expect(redactSecrets(input)).toBe(input);
  });

  it('returns a JSON-shaped string with short field values unchanged', () => {
    const input = JSON.stringify({ status: 'ok', version: 42, name: 'my-service' });
    expect(redactSecrets(input)).toBe(input);
  });

  it('returns a string that contains a short alphanum value (< 40 chars) unchanged', () => {
    // 39 consecutive alphanumeric chars — one short of pattern 6's threshold.
    const input = `key=${repeat('z', 39)}`;
    expect(redactSecrets(input)).toBe(input);
  });
});
