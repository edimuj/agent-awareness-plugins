# actions-watcher

An [agent-awareness](https://github.com/edimuj/agent-awareness) plugin that monitors GitHub Actions workflow runs and reports failures and recoveries. Works with private repos.

## Features

- **Auto-discovery** — set `owner` to automatically find all repos with workflows
- **Stale filtering** — `maxAgeDays` silences old/inactive projects
- **Delta-only reporting** — only reports state changes (new failures, recoveries)
- **Private repo support** — uses `gh` CLI authentication
- **Parallel fetching** — checks all repos concurrently
- **Workflow & branch filtering** — focus on the workflows that matter
- **Silent when green** — zero tokens wasted when everything passes

## Installation

```bash
npm install -g agent-awareness-plugin-actions-watcher
```

The agent-awareness loader auto-discovers `agent-awareness-plugin-*` packages from both global and local `node_modules/`.

## Triggers

| Trigger | Default | Description |
|---------|---------|-------------|
| `session-start` | **`full`** | Full report of all failing workflows at session start |
| `interval:5m` | **`delta`** | Delta-only: new failures and recoveries since last check |

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

### Auto-discovery (recommended)

```json
{
  "owner": "your-github-username",
  "maxAgeDays": 14
}
```

On each session start, the plugin lists all repos for the owner, checks which ones have workflow runs, and watches them automatically. Repos with only stale runs (older than `maxAgeDays`) produce no output.

### Explicit repos

```json
{
  "repos": [
    "edimuj/app-chat-game",
    "edimuj/my-private-api"
  ],
  "maxAgeDays": 30,
  "branchFilter": ["main"]
}
```

You can combine both — `owner` discovers repos, `repos` adds extras.

| Option | Default | Description |
|--------|---------|-------------|
| `owner` | `""` | GitHub owner for auto-discovery. Empty = discovery disabled |
| `repos` | `[]` | Explicit repos to monitor (`owner/name`). Merged with discovered repos |
| `focusCurrentRepo` | `true` | Prioritize current session's repo when it matches a watched repo |
| `maxAgeDays` | `14` | Ignore workflow runs older than this many days |
| `autonomy` | `"report"` | `"report"` = inform only, `"full"` = directive to fix and monitor |
| `workflowFilter` | `[]` | Workflow name substrings to include. Empty = all workflows |
| `branchFilter` | `[]` | Only report runs on these branches. Empty = all branches |
| `limit` | `10` | How many recent runs to fetch per repo |

## Output

**Session start** — failing workflows only (passing is silent):
```
edimuj/app-chat-game: 1 failing workflows
  iOS Maestro Nightly Matrix (main): FAILED — 2h ago
```

**Interval** — failures and recoveries only:
```
FAILED: edimuj/app-chat-game / nightly-e2e (main, schedule, 5m ago)
RECOVERED: edimuj/app-chat-game / nightly-e2e (main, 2m ago)
```

### Autonomy levels

With `"autonomy": "full"`, the plugin appends actionable directives:
```
edimuj/app-chat-game: 1 failing workflows
  nightly-e2e (main): FAILED — 2h ago. Action required: clone the repo, check the workflow logs (gh run view), identify the failure cause, fix it, push, and monitor until the run passes.
```

With `"autonomy": "report"` (default), the agent is only informed — no action directives.

## Multi-agent coordination

When multiple Claude Code sessions are running concurrently, the plugin claims each repo's workflow batch so only one session reports it. Unclaimed repos are silently skipped — another session handles them. State is always updated for all repos regardless of claim ownership, keeping delta tracking accurate.

## License

MIT
