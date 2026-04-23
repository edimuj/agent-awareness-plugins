# agent-awareness-plugin-weather

Injects local weather conditions into agent context using Open-Meteo (no API key required).

## Install

```bash
npm install -g agent-awareness-plugin-weather
```

Auto-discovered by [agent-awareness](https://github.com/edimuj/agent-awareness) — no manual registration needed.

## Triggers

| Trigger | Default | Description |
|---------|---------|-------------|
| `session-start` | **yes** | Inject weather snapshot at session start |
| `change:hour` | **yes** | Re-inject when conditions change (checked each hour) |

## Configuration

`~/.config/agent-awareness/plugins.d/weather.json`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `latitude` | number | auto | Latitude for weather lookup; auto-detected from IP if omitted |
| `longitude` | number | auto | Longitude for weather lookup; auto-detected from IP if omitted |
| `city` | string | auto | Display name used in output; auto-detected from IP if omitted |
| `showTemp` | boolean | `true` | Show temperature |
| `showFeelsLike` | boolean | `true` | Show "feels like" temperature |
| `showCondition` | boolean | `true` | Show weather condition description |
| `showWind` | boolean | `true` | Show wind speed |
| `showSunset` | boolean | `true` | Show sunset time |
| `feelsLikeDelta` | number | `3` | Only show "feels like" when it differs from actual temp by at least this many degrees |
| `onlyWhenChanged` | boolean | `false` | Only inject on hourly checks when temp or condition code has changed since last report |

Example — Stockholm, suppress unchanged hourly updates:

```json
{
  "latitude": 59.33,
  "longitude": 18.07,
  "city": "Stockholm",
  "onlyWhenChanged": true
}
```

## Output examples

```
Weather Stockholm: 12°C (feels 8°) Partly cloudy | Wind: 15km/h | Sunset: 20:45
```

When feels-like is within `feelsLikeDelta`:

```
Weather Stockholm: 15°C Clear sky | Wind: 8km/h | Sunset: 21:02
```

## Requirements

- [agent-awareness](https://github.com/edimuj/agent-awareness) core installed
- Node 18+
- Internet access (Open-Meteo API + IP geolocation fallback)

## License

MIT
