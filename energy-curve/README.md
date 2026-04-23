# agent-awareness-plugin-energy-curve

Injects your energy level and focus guidance into agent context based on time of day and a configurable daily schedule.

## Install

```bash
npm install -g agent-awareness-plugin-energy-curve
```

Auto-discovered by [agent-awareness](https://github.com/edimuj/agent-awareness) — no manual registration needed.

## Triggers

| Trigger | Default | Description |
|---------|---------|-------------|
| `session-start` | **yes** | Inject energy level at session start |
| `change:hour` | **yes** | Re-inject when the energy level changes (checked each hour) |

Only injects when the energy level changes between checks — no output if you're still in the same phase.

## Configuration

`~/.config/agent-awareness/plugins.d/energy-curve.json`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `profile` | string | `"nine-to-five"` | Built-in schedule profile to use |
| `startHour` | number\|null | `null` | Start-of-day hour — generates a standard curve from that point; overrides `profile` |
| `weekday` | array\|null | `null` | Fully custom weekday ranges array; overrides `profile` and `startHour` |
| `weekend` | array\|null | `null` | Fully custom weekend ranges; falls back to shifted weekday if omitted |
| `weekendShift` | number | `2` | Hours to shift weekday schedule on weekends (when `weekend` is not set) |
| `timezone` | string | `"auto"` | Timezone name (e.g. `"Europe/Stockholm"`) or `"auto"` to use system timezone |

**Config tiers (lowest to highest priority):** `profile` < `startHour` < custom `weekday`/`weekend` ranges.

Example — start-of-day at 8:

```json
{
  "startHour": 8,
  "weekendShift": 3,
  "timezone": "Europe/Stockholm"
}
```

Example — fully custom ranges:

```json
{
  "weekday": [
    { "start": 7, "end": 9, "level": "ramp-up" },
    { "start": 9, "end": 12, "level": "peak" },
    { "start": 12, "end": 14, "level": "dip" },
    { "start": 14, "end": 17, "level": "recovery" },
    { "start": 17, "end": 20, "level": "wind-down" }
  ],
  "weekend": [
    { "start": 10, "end": 13, "level": "ramp-up" },
    { "start": 13, "end": 16, "level": "peak" }
  ]
}
```

## Output examples

Weekday peak window:

```
Energy: 🔥 Peak (09–12) -- Deep work window — tackle the hardest problem first
```

Weekend ramp-up:

```
Energy: ☀️ Ramp-up (11–14, weekend) -- Ease in — light tasks and planning
```

## Requirements

- [agent-awareness](https://github.com/edimuj/agent-awareness) core installed
- Node 18+

## License

MIT
