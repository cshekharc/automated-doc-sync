#!/usr/bin/env bash
# Run once per machine to wire up the MCP servers this capstone uses.
# Requires: `claude` CLI installed and on PATH, `gh` CLI authenticated.
#
# ── Required environment variables ──────────────────────────────────────────
#
# GitHub MCP server (@modelcontextprotocol/server-github):
#   GITHUB_TOKEN   — Personal Access Token or GitHub App installation token
#                    with `repo` + `pull_requests` scopes.
#                    Create one at: github.com/settings/tokens
#
# Atlassian MCP server (@modelcontextprotocol/server-atlassian):
#   ATLASSIAN_URL        — Your Confluence Cloud base URL,
#                          e.g. https://yourorg.atlassian.net
#   ATLASSIAN_USERNAME   — The email address of your Atlassian account.
#   ATLASSIAN_API_TOKEN  — Atlassian Cloud API token (NOT your password).
#                          Create one at: id.atlassian.com/manage-profile/security/api-tokens
#
# Set these in your shell profile (~/.bashrc, ~/.zshrc, etc.) before running
# Claude Code, or export them in the current shell session:
#
#   export GITHUB_TOKEN="ghp_..."
#   export ATLASSIAN_URL="https://yourorg.atlassian.net"
#   export ATLASSIAN_USERNAME="you@example.com"
#   export ATLASSIAN_API_TOKEN="ATATT..."
#
# The MCP processes inherit these from the parent shell — they are NEVER
# hardcoded into .mcp.json or any tracked file (enforced by secret-scan.sh).
#
# ── NOTE: project .mcp.json already declares both servers ───────────────────
# If .mcp.json is present (it is, at repo root), you do NOT need to run this
# script — Claude Code loads the servers automatically.  Run this script only
# if you want to re-register them under a different scope or name.
#
# ────────────────────────────────────────────────────────────────────────────
set -e

echo "Adding GitHub MCP server..."
claude mcp add github --scope project -- npx -y @modelcontextprotocol/server-github

echo "Adding Atlassian (Jira + Confluence) MCP server..."
claude mcp add atlassian --scope project -- npx -y @modelcontextprotocol/server-atlassian

echo ""
echo "Done. Verify with: claude mcp list"
echo ""
echo "IMPORTANT: ensure these env vars are exported before starting Claude Code:"
echo "  GITHUB_TOKEN, ATLASSIAN_URL, ATLASSIAN_USERNAME, ATLASSIAN_API_TOKEN"
