# Tilde Harness Plugins

Session-start helpers for enabling Tilde MCP servers and skill registries in
local agent CLIs.

## Commands

```bash
tilde-session --cli codex
tilde-codex -- --model gpt-5.3-codex
tilde-claude -- --dangerously-skip-permissions
```

`tilde-session` configures a target CLI without launching it unless `--launch`
is passed. The wrapper commands configure first, then launch the corresponding
CLI with arguments after `--`.

Supported CLI values:

- `claude`
- `codex`
- `cursor`
- `opencode`
- `gemini`

## Selection

Interactive mode calls `/api/v1/identity/auth/whoami`, lists every team the user
belongs to, then queries each team for MCP servers and skill registries. It uses
a checkbox terminal selector for both lists. Press Space to toggle entries,
Enter to confirm. In CI or with `--non-interactive`, all returned servers and
registries are selected.

Labels are rendered as:

```text
$team / $server
$team / $registry
```

## Environment

- `TILDE_API_BASE_URL`: API origin, default `https://api.tilde.test`
- `TILDE_TEAM_ID`: optional team filter; omit to discover all teams from whoami
- `TILDE_TEAM_NAME`: optional display name for labels
- `TILDE_API_KEY`: optional bearer token
- `TILDE_AGENT_HOME`: destination home dir override

## Outputs

MCP config files:

- Claude: `~/.claude/mcp.json`
- Codex: `~/.codex/mcp.json`
- Cursor: `~/.cursor/mcp.json`
- OpenCode: `~/.config/opencode/mcp.json`
- Gemini: `~/.gemini/settings.json`

Skill registries are downloaded atomically into each CLI's skills directory.
