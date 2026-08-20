#!/usr/bin/env bash
# PostToolUse hook (matcher: Write|Edit) - auto-format TS/JS files.
input=$(cat)
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

case "$file_path" in
  *.ts|*.tsx|*.js|*.jsx)
    if [ -f package.json ] && [ -x node_modules/.bin/prettier ]; then
      node_modules/.bin/prettier --write "$file_path" >/dev/null 2>&1
    fi
    ;;
esac

exit 0
