/**
 * Utility for redacting well-known secret patterns from log output and
 * error messages before they are written to stdout (architecture §8.5, F-12).
 *
 * @module redact-secrets
 */

/**
 * Ordered list of compiled regular expressions covering the six secret
 * pattern families defined in architecture §8.5.
 *
 * Patterns are applied in declaration order so that the more-specific
 * named-prefix patterns (1–5) are consumed before the generic Base64
 * catch-all (6). Every pattern carries the global flag so that all
 * occurrences within a single string are replaced.
 *
 * | # | Pattern | Secret type |
 * |---|---------|-------------|
 * | 1 | `ghp_[A-Za-z0-9]{36,}` | GitHub PAT classic |
 * | 2 | `ghs_[A-Za-z0-9]{36,}` | GitHub Apps token |
 * | 3 | `github_pat_[A-Za-z0-9_]{36,}` | GitHub fine-grained PAT |
 * | 4 | `ATATT[A-Za-z0-9+/=_-]{20,}` | Confluence Cloud API token |
 * | 5 | `Bearer\s+[A-Za-z0-9._-]{20,}` | Generic Bearer header token |
 * | 6 | `[A-Za-z0-9+/]{40,}={0,2}` | Generic Base64 blob ≥ 40 chars |
 *
 * Note: pattern 6 may produce false positives on long hex strings such as
 * git SHAs — this is accepted behaviour per architecture §8.5.
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /ghp_[A-Za-z0-9]{36,}/g,
  /ghs_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{36,}/g,
  /ATATT[A-Za-z0-9+/=_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{20,}/g,
  /[A-Za-z0-9+/]{40,}={0,2}/g,
];

/** Replacement token used in place of every redacted match. */
const REDACTED_PLACEHOLDER = '[REDACTED]';

/**
 * Replaces every occurrence of a known secret pattern in `text` with
 * the literal string `[REDACTED]`.
 *
 * The six pattern families covered are defined in architecture §8.5:
 * - GitHub PAT classic (`ghp_...`)
 * - GitHub Apps token (`ghs_...`)
 * - GitHub fine-grained PAT (`github_pat_...`)
 * - Confluence Cloud API token (`ATATT...`)
 * - Generic Bearer-header token (`Bearer <value>`)
 * - Generic Base64 blob of 40 or more characters
 *
 * Patterns are applied sequentially in the order listed above.  Named-prefix
 * patterns (1–5) therefore run before the generic Base64 catch-all (6),
 * ensuring that already-replaced `[REDACTED]` placeholders are never
 * re-processed by subsequent patterns.
 *
 * The function never mutates `text`; it always returns a new string.
 * When no pattern matches, the return value is character-for-character
 * identical to the input.
 *
 * @param text - The raw string that may contain sensitive credential values.
 * @returns A new string with every matched secret replaced by `[REDACTED]`.
 *
 * @example
 * ```typescript
 * redactSecrets('token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
 * // => 'token: [REDACTED]'
 *
 * redactSecrets('no secrets here')
 * // => 'no secrets here'
 * ```
 */
export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACTED_PLACEHOLDER);
  }
  return result;
}
