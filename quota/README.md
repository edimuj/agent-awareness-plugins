# agent-awareness-plugin-quota

Provider-aware quota visibility for Claude Code and Codex — injects token usage percentages into context so the agent can adapt its verbosity and delegation strategy.

## Install

```bash
npm install -g agent-awareness-plugin-quota
```

Auto-discovered by [agent-awareness](https://github.com/edimuj/agent-awareness) — no manual registration needed.

## Triggers

| Trigger | Default | Description |
|---------|---------|-------------|
| `session-start` | **yes** | Inject quota snapshot at session start |
| `interval:5m` | no | Re-check every 5 minutes |
| `interval:10m` | no | Re-check every 10 minutes |
| `interval:15m` | **yes** | Re-check every 15 minutes |
| `interval:30m` | no | Re-check every 30 minutes |

Delta-only reporting: an interval check only injects output when the burst% or weekly% has actually changed since last report. Session duration alone does not trigger a new injection.

## Configuration

`~/.config/agent-awareness/plugins.d/quota.json`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `showSession` | boolean | `true` | Show session duration |
| `showBurst` | boolean | `true` | Show 5h burst window usage |
| `showWeekly` | boolean | `true` | Show 7d weekly window usage |
| `showResetTime` | boolean | `true` | Show countdown to burst window reset |
| `burstSignals` | array | `[{pct:80,"CONSERVE"},{pct:60,"consider delegating"}]` | Alert messages when burst% crosses threshold |
| `weeklySignals` | array | `[{pct:90,"WARNING"}]` | Alert messages when weekly% crosses threshold |

Example:

```json
{
  "showSession": true,
  "showBurst": true,
  "showWeekly": true,
  "showResetTime": true,
  "burstSignals": [
    { "pct": 80, "message": "CONSERVE" },
    { "pct": 60, "message": "consider delegating" }
  ],
  "weeklySignals": [
    { "pct": 90, "message": "WARNING" }
  ]
}
```

## Output examples

Normal:

```
Session: 5min | 5h: 2% (↻4h10m) | 7d: 54%
```

With burst signal triggered:

```
Session: 45min | 5h: 82% CONSERVE (↻1h30m) | 7d: 54%
```

## Providers

- **Claude Code** — reads usage via API
- **Codex** — reads usage via app-server RPC

## Requirements

- [agent-awareness](https://github.com/edimuj/agent-awareness) core installed
- Node 18+

## License

MIT
