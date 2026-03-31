# pr-pilot

An [agent-awareness](https://github.com/edimuj/agent-awareness) provider plugin that tracks your open PRs on external repos and helps your AI agent manage the entire PR lifecycle — from CI failures to review responses to stale PR cleanup.

## Why

Getting PRs merged on external repos is harder than ever. AI security audits, automated reviewers, complex CI suites — a PR that isn't actively maintained dies within days. This plugin gives your agent ambient awareness of all your outbound PRs so it can act immediately when something needs attention.

**Plugin = eyes and ears. Agent = brain and hands.**

## Features

- **Auto-discovery** — finds your open PRs across GitHub (external repos by default), zero config
- **Event detection** — CI failures, review comments, merge conflicts, staleness
- **Configurable autonomy** — per-event control: notify, suggest, or instruct the agent to act
- **Dormancy backoff** — active PRs checked every 5 min, dormant PRs ~hourly
- **Two-stage staleness** — warning at 7 days, auto-cleanup at 30 days (configurable)
- **MCP tools** — manual tracking, status checks, force re-checks
- **Zero token waste** — silent when nothing changed

## Installation

```bash
npm install -g agent-awareness-plugin-pr-pilot
```

The agent-awareness loader auto-discovers `agent-awareness-plugin-*` packages from both global and local `node_modules/`.

## Configuration

Create `~/.config/agent-awareness/plugins.d/pr-pilot.json`:

```json
{
  "enabled": true,
  "autoDiscover": true,
  "includeOwnRepos": false,
  "includeControlledOrgRepos": false,
  "repos": [],
  "username": "",
  "autonomy": {
    "checksFailure": "act",
    "reviewChanges": "suggest",
    "conflicts": "suggest",
    "stale": "notify",
    "abandoned": "suggest",
    "labels": "notify"
  },
  "staleDays": 7,
  "staleTtlDays": 30,
  "dormantBackoffCycles": 12,
  "triggers": {
    "session-start": "dashboard",
    "interval:5m": "events"
  }
}
```

### Config options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `autoDiscover` | `boolean` | `true` | Auto-find open PRs via `gh search prs --author` |
| `includeOwnRepos` | `boolean` | `false` | Include PRs targeting repos owned by your username |
| `includeControlledOrgRepos` | `boolean` | `false` | Include PRs targeting org repos where you have write/maintain/admin permission |
| `repos` | `string[]` | `[]` | Repo allowlist for auto-discovery (empty = all repos) |
| `username` | `string` | `""` | GitHub username (empty = resolve from `gh auth status`) |
| `autonomy` | `object` | see below | Per-event autonomy levels |
| `staleDays` | `number` | `7` | Days of inactivity before `pr_stale` event |
| `staleTtlDays` | `number` | `30` | Days of inactivity before `pr_abandoned` + removal |
| `dormantBackoffCycles` | `number` | `12` | Check dormant PRs every Nth cycle (~hourly at 5m) |

### Autonomy levels

Each event type can be set to one of three levels:

| Level | Behavior | Example |
|-------|----------|---------|
| `notify` | Bare facts | "CI failed on owner/repo#42: eslint, 3 errors" |
| `suggest` | Facts + recommendation | "...Suggested: clone, fix lint, push" |
| `act` | Facts + explicit instruction | "...Action required: clone repo, fix lint, push fix commit" |

### Autonomy defaults

| Event | Default | Rationale |
|-------|---------|-----------|
| `checksFailure` | `act` | CI fixes are mechanical, high confidence |
| `reviewChanges` | `suggest` | Needs judgment — reviewer might be wrong |
| `conflicts` | `suggest` | Rebasing can go sideways |
| `stale` | `notify` | Informational |
| `abandoned` | `suggest` | "Consider closing this" |
| `labels` | `notify` | Informational |

### Trigger formats

- `"session-start": "dashboard"` — full overview grouped by urgency
- `"interval:5m": "events"` — only new events since last check (silent when nothing changed)

## Output examples

**Dashboard (session-start):**
```
PR Pilot: 3 tracked PRs

🔴 Needs action:
  vercel/next.js#4521 — Fix SSR hydration mismatch
    CI failed: eslint, jest; @maintainer requested changes (2 comments)

⏳ Waiting:
  facebook/react#28901 — Add useAbortSignal hook
    checks passing, 1 approval

💤 Dormant:
  nodejs/node#51234 — Improve stream backpressure docs
    No activity for 12 days
```

**Events (interval):**
```
PR Pilot: CI failed on vercel/next.js#4521 "Fix SSR hydration mismatch": 2 failed: eslint, jest. Action required: clone repo, fix failing checks, run tests locally, push fix commit
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `awareness_pr_pilot_track` | Manually track a PR (URL or owner/repo#N) |
| `awareness_pr_pilot_untrack` | Stop tracking a PR |
| `awareness_pr_pilot_list` | List tracked PRs with status summary |
| `awareness_pr_pilot_status` | Detailed breakdown for a specific PR |
| `awareness_pr_pilot_check` | Force re-check a PR right now |

## Discovery modes

- **`autoDiscover: true`** (default) — polls GitHub search API for your open PRs. By default it excludes repos you control (your own repos plus org repos where you have write-level permission). Optional `repos` allowlist limits scope. Discovery runs at session start and every ~30 minutes.
- **`autoDiscover: false`** — explicit tracking only via the `track` MCP tool.
- Manual tracking via `track` is always available regardless of mode.

## Staleness lifecycle

1. **Active** — checked every 5 minutes
2. **Dormant** (24h inactive) — checked ~hourly via backoff
3. **Stale** (`staleDays`, default 7) — `pr_stale` event fires once
4. **Abandoned** (`staleTtlDays`, default 30) — `pr_abandoned` event fires, PR removed next cycle

This ensures PRs don't accumulate forever in state.

## Requirements

- `gh` CLI installed and authenticated
- agent-awareness v0.2.0+

## License

MIT
