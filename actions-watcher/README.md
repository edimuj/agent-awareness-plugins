# actions-watcher

An [agent-awareness](https://github.com/edimuj/agent-awareness) plugin that monitors GitHub Actions workflow runs and reports failures and recoveries. Works with private repos.

## Features

- **Delta-only reporting** — only reports state changes (new failures, recoveries)
- **Private repo support** — uses `gh` CLI authentication
- **Parallel fetching** — checks all repos concurrently
- **Workflow & branch filtering** — focus on the workflows that matter
- **MCP tools** — on-demand `check` and `runs` for real-time queries
- **Silent when green** — zero tokens wasted when everything passes

## Installation

```bash
npm install -g agent-awareness-plugin-actions-watcher
```

The agent-awareness loader auto-discovers `agent-awareness-plugin-*` packages from both global and local `node_modules/`.

## Prerequisites

- [`gh` CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)

## Configuration

Create a config file for the rig/project where you want CI awareness:

```
~/.claude-rig/rigs/<rig-name>/agent-awareness/plugins.d/actions-watcher.json
```

Or globally:

```
~/.config/agent-awareness/plugins.d/actions-watcher.json
```

```json
{
  "repos": [
    "edimuj/app-chat-game",
    "edimuj/my-private-api"
  ],
  "workflowFilter": [],
  "branchFilter": ["main"],
  "limit": 10
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `repos` | `[]` | Repos to monitor (`owner/name`). Empty = plugin stays silent |
| `workflowFilter` | `[]` | Workflow name substrings to include. Empty = all workflows |
| `branchFilter` | `[]` | Only report runs on these branches. Empty = all branches |
| `limit` | `10` | How many recent runs to fetch per repo |

## Output

**Session start** — full status of all watched workflows:
```
edimuj/app-chat-game: 2 workflows — all green
  ✅ push (main): passing — 2h ago
  ✅ nightly-e2e (main): passing — 8h ago
```

**Interval** — delta only (failures and recoveries):
```
🔴 FAILED: edimuj/app-chat-game / nightly-e2e (main, schedule, 5m ago)
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `awareness_actions_watcher_check` | Force re-check all repos (or one specific repo) |
| `awareness_actions_watcher_runs` | List recent workflow runs for a repo |

## License

MIT
