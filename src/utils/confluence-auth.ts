/**
 * Builds the `Authorization: Basic` header value for Atlassian Cloud's
 * REST API: `base64(username + ":" + token)`, where `username` is the
 * Atlassian account email address and `token` is the API token.
 *
 * Centralises the encoding so that every caller — ConfluencePublisher,
 * DocLocator, and ConfluencePublish — produces identical headers from one
 * shared implementation rather than three independent Buffer.from() calls.
 *
 * The returned string contains a Base64 blob and **must** be passed through
 * {@link redactSecrets} before any logging (NFR-2).
 *
 * @param username - Atlassian account email (value of `CONFLUENCE_USERNAME`).
 * @param token    - Raw Atlassian Cloud API token (value of `CONFLUENCE_API_TOKEN`).
 * @returns `"Basic <base64(username + \":\" + token)>"`
 */
export function buildConfluenceAuthHeader(username: string, token: string): string {
  return `Basic ${Buffer.from(username + ':' + token).toString('base64')}`;
}
