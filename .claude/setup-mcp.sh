#!/usr/bin/env bash
# Run once per machine to wire up the MCP servers this capstone uses.
# Requires: `claude` CLI installed and on PATH, `gh` CLI authenticated.
set -e

echo "Adding GitHub MCP server..."
claude mcp add github --scope project -- npx -y @modelcontextprotocol/server-github

echo "Adding Atlassian (Jira + Confluence) MCP server..."
claude mcp add atlassian --scope project -- npx -y @modelcontextprotocol/server-atlassian

echo "Done. Verify with: claude mcp list"
echo "Auth tokens are supplied via env vars (GITHUB_TOKEN / ATLASSIAN_*),"
echo "never hardcoded into .mcp.json — check .claude/hooks/secret-scan.sh"
echo "will block any accidental token paste into a tracked file."
