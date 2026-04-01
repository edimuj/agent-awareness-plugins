# agent-awareness-plugin-energy-curve

Adapts agent response style to your energy rhythm across the day.

## Install

```bash
npm install -g agent-awareness-plugin-energy-curve
```

## Config

`~/.config/agent-awareness/plugins.d/energy-curve.json`

```json
{
  "profile": "nine-to-five",
  "weekendShift": 2,
  "timezone": "auto"
}
```

Supports profile mode, `startHour` mode, and fully custom weekday/weekend ranges.
