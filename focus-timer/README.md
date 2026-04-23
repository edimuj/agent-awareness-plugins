# agent-awareness-plugin-focus-timer

Pomodoro-style timer that injects focus/break state into agent context and auto-transitions between phases. Includes MCP tools for real-time control.

## Install

```bash
npm install -g agent-awareness-plugin-focus-timer
```

Auto-discovered by [agent-awareness](https://github.com/edimuj/agent-awareness) — no manual registration needed.

## Triggers

| Trigger | Default | Description |
|---------|---------|-------------|
| `session-start` | **yes** | Report timer state at session start |
| `prompt` | **yes** | Check and advance timer state on every prompt |

Silent when no timer is running — no output injected when idle.

## Configuration

`~/.config/agent-awareness/plugins.d/focus-timer.json`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `focusMinutes` | number | `25` | Length of each focus session in minutes |
| `breakMinutes` | number | `5` | Length of a short break in minutes |
| `longBreakMinutes` | number | `15` | Length of a long break in minutes |
| `longBreakAfter` | number | `4` | Number of focus sessions before a long break |
| `autoBreak` | boolean | `true` | Automatically transition from focus to break when focus expires |

Example:

```json
{
  "focusMinutes": 50,
  "breakMinutes": 10,
  "longBreakMinutes": 30,
  "longBreakAfter": 3,
  "autoBreak": true
}
```

## Output examples

During focus:

```
Focus: 18min left (session #2) -- minimize distractions
```

Break started:

```
Break: 5min -- session #2 complete, step away
```

Break over:

```
Break over -- ready for focus session #3
```

## MCP tools

The plugin exposes MCP tools for controlling the timer mid-session:

| Tool | Description |
|------|-------------|
| `awareness_focus_timer_start` | Start a new focus session |
| `awareness_focus_timer_break` | Start a break immediately |
| `awareness_focus_timer_stop` | Stop the timer and go idle |
| `awareness_focus_timer_extend` | Extend the current session |
| `awareness_focus_timer_status` | Get current timer state |

## Requirements

- [agent-awareness](https://github.com/edimuj/agent-awareness) core installed
- Node 18+

## License

MIT
