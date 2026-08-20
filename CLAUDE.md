# Project: Automated Documentation Sync (Agentic SDLC Capstone)

## What this project is
An agentic pipeline that detects drift between TypeScript source code and
published documentation (Confluence/README/docs site), regenerates the
stale sections, and opens a PR for human review. This CLAUDE.md is read by
Claude Code at the start of every session — keep it short and factual.

## SDLC phases (Human-in-the-Loop between every phase)
1. Requirements   -> docs/requirements.md
2. Architecture    -> docs/architecture.md
3. Design Review   -> docs/design-review.md
4. Impl. Plan      -> docs/impl-plan.md
5. Implementation  -> src/
6. Code Review     -> docs/code-review.md
7. Verification    -> docs/verification-report.md
8. PR              -> opened via `gh pr create`

Each phase is driven by a slash command in `.claude/commands/` which
delegates to a specialist subagent in `.claude/agents/`. **Do not skip a
phase and do not let an agent start the next phase's file until the human
has explicitly approved the current one** — this is enforced by the
`phase-gate.sh` PreToolUse hook in `.claude/settings.json`.

## Tech stack
- Language: TypeScript / Node.js
- Test framework: Vitest (unit) + Playwright (integration/e2e, since this
  is a QA-automation-flavored capstone)
- Package manager: npm
- CI: GitHub Actions

## Conventions
- Conventional commits: `feat:`, `fix:`, `docs:`, `test:`, `chore:`
- No secrets, tokens, or `.env` values ever written to docs/ or committed
- Every exported function needs a doc-comment; the doc-sync pipeline
  regenerates docs FROM these comments, so keep them accurate
- Docs live in `docs/` as Markdown; treat `docs/*.md` as generated-but-
  human-approved artifacts (append-only history is fine, don't silently
  overwrite without a diff shown to the human)

## Build & test
- `npm install`
- `npm run build`
- `npm test` (Vitest unit tests)
- `npm run test:e2e` (Playwright)
- `npm run lint`

## Known gaps / "Not Found" policy
If a subagent cannot find information it needs (e.g. no JIRA ticket
linked, a source file has no doc-comment), it must write `Not Found` in
the relevant section rather than inventing content, and list it under
"Known Limitations" in the eventual PR description.
