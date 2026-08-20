# Automated Documentation Sync — Claude Code Edition

This scaffold reimplements the GitHub Copilot capstone
("Agentic SDLC Use Case: Automated Documentation Sync") using Claude
Code's own primitives instead of Copilot's. Same 8-phase SDLC, same
human-in-the-loop (HITL) gates between phases — different engine.

## How the Copilot conventions map to Claude Code

| GitHub Copilot | Claude Code | Where it lives here |
|---|---|---|
| `.github/agents/` custom agents | Subagents | `.claude/agents/*.md` |
| `.github/prompts/` prompt files | Slash commands | `.claude/commands/*.md` |
| `.github/instructions/` | Project memory | `CLAUDE.md` |
| Copilot Skills | Claude Skills (optional, see note below) | `.claude/skills/` if you add any |
| Copilot Hooks | Hooks | `.claude/settings.json` + `.claude/hooks/*.sh` |
| MCP servers (Jira/Confluence/GitHub) | MCP servers | `.claude/setup-mcp.sh` |
| Agent Mode PR creation | `pr-writer` subagent + `gh` CLI | `.claude/agents/pr-writer.md` |

Note: as of recent Claude Code versions, custom slash commands and Skills
have converged (a Skill can be invoked the same way a command is). This
scaffold uses plain `.claude/commands/` because it's the simplest 1:1
mapping to Copilot's "prompt files" and is enough for a capstone. If you
want to go further, you can migrate each command into a full Skill
later (`.claude/skills/<name>/SKILL.md`) without changing anything else.

## One-time setup

```bash
cd automated-doc-sync
npm install                # once you've scaffolded package.json (Step 5)
claude mcp add github --scope project -- npx -y @modelcontextprotocol/server-github
claude mcp add atlassian --scope project -- npx -y @modelcontextprotocol/server-atlassian
chmod +x .claude/hooks/*.sh
```

Confirm hooks and MCP are wired up: run `claude`, then inside the
session type `/hooks` and `/mcp` to verify.

## Running the 8-phase pipeline

Each phase is a slash command that delegates to a specialist subagent.
**Stop and read the output at every phase** — that pause is the HITL
gate. The `phase-gate.sh` hook enforces ordering mechanically (it won't
let a phase-2 artifact be written before phase-1's exists), but only you
can decide whether phase 1's content is actually *good*.

```bash
claude

# Phase 1 — Requirements
/requirements <paste your user story, or a Jira link, or "read docs/user-story.docx">
# -> review docs/requirements.md, answer any clarifying questions asked,
#    edit by hand if needed, THEN move on.

# Phase 2 — Architecture
/architecture
# -> review docs/architecture.md

# Phase 3 — Design Review
/design-review
# -> review docs/design-review.md; if verdict is "Approved with changes",
#    apply them (ask the architect subagent, or edit yourself) before Phase 4

# Phase 4 — Implementation Planning
/plan
# -> review docs/impl-plan.md, note the task IDs

# Phase 5 — Implementation (repeat per task)
/implement TASK-1
/implement TASK-2
# ... one task at a time; review the diff after each before continuing

# Phase 6 — Review
/review
# -> review docs/code-review.md; if "Not Ready", loop back to /implement

# Phase 7 — Verify
/verify
# -> review docs/verification-report.md

# Phase 8 — PR
/pr
# -> review the PR Claude opens with `gh pr create`; you approve/merge it
```

## Best practices baked into this scaffold

- **One subagent, one responsibility.** Each phase agent has a narrow
  tool allowlist (e.g. `code-reviewer` is read-only — it can't "fix" what
  it's supposed to be catching).
- **Deterministic gates over prompted promises.** Phase ordering and
  secret-leak prevention are enforced by shell hooks (`PreToolUse`, exit
  code 2 = block), not just instructions in a prompt — instructions can
  be ignored under context pressure, hooks can't.
- **`Not Found` over hallucination.** Every agent's instructions say to
  write `Not Found` / flag a blocker instead of inventing content — this
  mirrors the capstone's own "Known Limitations" requirement.
- **Right model per phase.** Cheaper/faster model (`sonnet`) for
  mechanical work (requirements drafting, planning, implementation);
  higher-reasoning model (`opus`) reserved for architecture and design
  review, where the cost of a bad decision compounds downstream. Adjust
  the `model:` field in each agent's frontmatter to fit your budget.
- **Context isolation.** Each phase runs in its own subagent context —
  the verifier doesn't inherit the architect's entire back-and-forth, it
  gets a clean window and reads only the artifacts it needs from disk.
  This keeps each phase's output grounded in the actual approved
  document rather than conversational drift.
- **Everything is git-trackable.** Agents, commands, and hooks are plain
  files in `.claude/` — commit them, PR changes to your own SDLC process
  the same way you PR code, and your teammates get the same pipeline by
  cloning the repo.

## Extending this

- Add a `docs-drift-detector` subagent (read-only, `Read`/`Grep`/`Bash`)
  once you get to the actual "detect drift between code and docs" core
  feature — the 8 phases above are the meta-pipeline that builds that
  feature; the feature itself becomes its own set of implementation
  tasks under Phase 5.
- If you want fully automated phase transitions instead of you typing
  each `/command`, that trades away the HITL review the capstone asks
  for — worth doing only after you've run the manual version end-to-end
  once.
