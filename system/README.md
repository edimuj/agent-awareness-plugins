# agent-awareness-plugin-system

Reports disk, memory, and load metrics with threshold-based warnings.

## Install

```bash
npm install -g agent-awareness-plugin-system
```

## Config

`~/.config/agent-awareness/plugins.d/system.json`

```json
{
  "diskPath": "/",
  "onlyWhenWarning": false,
  "thresholds": {
    "diskPct": 80,
    "memoryPct": 80,
    "loadPerCpu": 2
  }
}
```
