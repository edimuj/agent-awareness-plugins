# agent-awareness-plugin-focus-timer

Pomodoro timer plugin that adapts agent behavior during focus and break sessions.
Includes MCP tools for real-time control.

## Install

```bash
npm install -g agent-awareness-plugin-focus-timer
```

## Config

`~/.config/agent-awareness/plugins.d/focus-timer.json`

```json
{
  "focusMinutes": 25,
  "breakMinutes": 5,
  "longBreakMinutes": 15,
  "longBreakAfter": 4,
  "autoBreak": true
}
```

## MCP tools

- `awareness_focus_timer_start`
- `awareness_focus_timer_break`
- `awareness_focus_timer_stop`
- `awareness_focus_timer_extend`
- `awareness_focus_timer_status`
