#!/usr/bin/env bash
# PreToolUse hook (matcher: Write|Edit)
# Enforces SDLC phase ordering deterministically. This is the mechanical
# half of the HITL gate — it stops an agent from writing phase N+1's
# artifact before phase N's artifact exists. It does NOT know whether a
# human actually reviewed phase N; that judgement call stays with you.
# Exit 2 = block the tool call and show stderr to Claude.

input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

block() {
  echo "Phase gate: $1" >&2
  exit 2
}

case "$file_path" in
  *docs/architecture.md)
    [ -f docs/requirements.md ] || block "docs/requirements.md must exist and be approved before architecture.md."
    ;;
  *docs/design-review.md)
    [ -f docs/architecture.md ] || block "docs/architecture.md must exist before a design review."
    ;;
  *docs/impl-plan.md)
    [ -f docs/design-review.md ] || block "docs/design-review.md must exist (with an Approved verdict) before planning."
    ;;
  src/*)
    [ -f docs/impl-plan.md ] || block "docs/impl-plan.md must exist before implementation starts."
    ;;
  *docs/code-review.md)
    [ -f docs/impl-plan.md ] || block "Implementation plan must exist before code review."
    ;;
  *docs/verification-report.md)
    [ -f docs/code-review.md ] || block "docs/code-review.md must exist before verification."
    ;;
esac

exit 0
