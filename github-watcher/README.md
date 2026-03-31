# github-watcher

An [agent-awareness](https://github.com/edimuj/agent-awareness) provider plugin that monitors GitHub repositories for new issues, PRs, and comments from external users.

## Features

- **Delta-only reporting** — tracks state per repo, only reports new activity since last check
- **External-only filtering** — ignore specific users like your own account or bots (`ignoreAuthors`)
- **Parallel fetching** — checks all repos concurrently
- **Compact + detailed formats** — compact for intervals, detailed for session start
- **MCP tools** — on-demand `check` and `repos` tools for real-time queries
- **Zero token waste** — silent when nothing new (`onlyWhenNew: true`)

## Installation

```bash
npm install -g agent-awareness-plugin-github-watcher
```

The agent-awareness loader auto-discovers `agent-awareness-plugin-*` packages from both global and local `node_modules/`.

## Configuration

Create `~/.config/agent-awareness/plugins.d/github-watcher.json`:

```json
{
  "enabled": true,
  "repos": [
    "owner/repo1",
    "owner/repo2"
  ],
  "ignoreAuthors": ["your-github-username", "dependabot[bot]"],
  "commentLimit": 10,
  "onlyWhenNew": true,
  "triggers": {
    "session-start": "detailed",
    "interval:15m": "compact"
  }
}
```

### Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `repos` | `string[]` | `[]` | Repos to watch (`owner/repo` format) |
| `ignoreAuthors` | `string[]` | `[]` | GitHub usernames to filter out |
| `commentLimit` | `number` | `10` | Max comments per repo per check |
| `format` | `string` | `"auto"` | Output format: `compact`, `detailed`, or `auto` |
| `onlyWhenNew` | `boolean` | `true` | Only inject when there's new activity |

### Trigger formats

Trigger values can be `true`/`false` or a format string (`"compact"` / `"detailed"`):

- `"session-start": "detailed"` — full breakdown at session start
- `"interval:15m": "compact"` — one-liner every 15 minutes

## Output examples

**Compact:**
```
GitHub: edimuj/tokenlean: 1 new issue, 2 new comments | edimuj/claude-rig: 1 new PR
```

**Detailed:**
```
GitHub activity:
**edimuj/tokenlean**
  📋 #42 Bug: CLI crashes on empty input (by @contributor)
  💬 #38 @reviewer: Looks good to me! Just one small nit on line 42…
**edimuj/claude-rig**
  🔀 #15 Add fish shell support (by @community-dev)
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `awareness_github_watcher_check` | Check repos for new activity right now |
| `awareness_github_watcher_repos` | List watched repos and last-check timestamps |

## Requirements

- `gh` CLI installed and authenticated
- agent-awareness v0.1.0+

## License

MIT
