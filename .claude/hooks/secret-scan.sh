#!/usr/bin/env bash
# PreToolUse hook (matcher: Write|Edit)
# Blocks any Write/Edit whose content looks like it contains a live
# credential (API keys, tokens, private keys). Deterministic guardrail —
# do not rely on the model to remember not to paste secrets.

input=$(cat)
content=$(echo "$input" | jq -r '.tool_input.content // .tool_input.new_string // empty')

pattern='(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[0-9A-Za-z-]{10,}|-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----|Bearer [A-Za-z0-9\-_\.]{20,})'

if echo "$content" | grep -qE "$pattern"; then
  echo "Secret scan: content matches a known credential pattern. Blocking write. Use an environment variable reference instead." >&2
  exit 2
fi

exit 0
