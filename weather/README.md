# agent-awareness-plugin-weather

Local weather context via Open-Meteo (no API key required).

## Install

```bash
npm install -g agent-awareness-plugin-weather
```

## Config

`~/.config/agent-awareness/plugins.d/weather.json`

```json
{
  "latitude": 59.33,
  "longitude": 18.07,
  "city": "Stockholm",
  "onlyWhenChanged": false
}
```

If latitude/longitude are omitted, the plugin falls back to IP geolocation.
