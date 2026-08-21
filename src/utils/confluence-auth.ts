/**
 * Builds the `Authorization: Basic` header value for Atlassian Cloud's
 * headless-auth scheme: `base64(":" + token)` (empty username, token as
 * the password field).
 *
 * Centralises the encoding so that every caller — ConfluencePublisher,
 * DocLocator, and ConfluencePublish — produces identical headers from one
 * shared implementation rather than three independent Buffer.from() calls.
 *
 * The returned string contains a Base64 blob and **must** be passed through
 * {@link redactSecrets} before any logging (NFR-2).
 *
 * @param token - Raw Atlassian Cloud API token (value of `CONFLUENCE_API_TOKEN`).
 * @returns `"Basic <base64(\":\" + token)>"`
 */
export function buildConfluenceAuthHeader(token: string): string {
  return `Basic ${Buffer.from(':' + token).toString('base64')}`;
}
