# agent-awareness-plugin-system

Injects disk, memory, and CPU load metrics into agent context with configurable warning thresholds.

## Install

```bash
npm install -g agent-awareness-plugin-system
```

Auto-discovered by [agent-awareness](https://github.com/edimuj/agent-awareness) — no manual registration needed.

## Triggers

| Trigger | Default | Description |
|---------|---------|-------------|
| `session-start` | **yes** | Inject system metrics at session start |
| `prompt` | no | Re-check on every prompt |
| `interval:15m` | **yes** | Re-check every 15 minutes |

## Configuration

`~/.config/agent-awareness/plugins.d/system.json`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `diskPath` | string | `"/"` | Filesystem path to report disk usage for |
| `showDisk` | boolean | `true` | Show disk usage |
| `showMemory` | boolean | `true` | Show free memory |
| `showLoad` | boolean | `true` | Show CPU load average |
| `onlyWhenWarning` | boolean | `false` | Suppress output entirely when all metrics are within thresholds |
| `thresholds.diskPct` | number | `80` | Disk usage % that triggers the disk warning message |
| `thresholds.memoryPct` | number | `80` | Memory usage % that triggers the memory warning message |
| `thresholds.loadPerCpu` | number | `2.0` | Load-per-CPU that triggers the load warning message |
| `messages.disk` | string | `"WARNING"` | Label appended when disk threshold is exceeded |
| `messages.memory` | string | `"WARNING"` | Label appended when memory threshold is exceeded |
| `messages.load` | string | `"HIGH"` | Label appended when load threshold is exceeded |

Example — suppress quiet output, stricter thresholds:

```json
{
  "onlyWhenWarning": true,
  "thresholds": {
    "diskPct": 70,
    "memoryPct": 75,
    "loadPerCpu": 1.5
  }
}
```

## Output examples

Normal:

```
Disk: 50% | Mem: 4.2G free | Load: 1.2
```

With warnings:

```
Disk: 85% WARNING | Mem: 1.1G free WARNING | Load: 3.5 HIGH
```

## Requirements

- [agent-awareness](https://github.com/edimuj/agent-awareness) core installed
- Node 18+

## License

MIT
