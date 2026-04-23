# server-health

An [agent-awareness](https://github.com/edimuj/agent-awareness) provider plugin for threshold-based server health alerts with hysteresis and cooldown.

## Design

Unlike simple polling monitors that report every check, this plugin operates on **state transitions**:

- **Alert on threshold breach** — first time only
- **Alert on recovery** — when metric returns to normal
- **Silent otherwise** — zero tokens wasted when healthy
- **Hysteresis** — prevents alert oscillation (e.g., memory at 79%→81%→79%→81%)
- **Cooldown** — minimum time between alerts for the same metric
- **Full status on session-start** — always shows all metrics at startup

## Metrics

| Metric | What it measures | Default thresholds |
|--------|-----------------|-------------------|
| `disk` | Disk usage per path | warn: 80%, crit: 90% |
| `memory` | RAM usage | warn: 80%, crit: 90% |
| `swap` | Swap usage | warn: 60%, crit: 80% |
| `load` | CPU load (normalized per-CPU %) | warn: 150%, crit: 250% |
| `openFiles` | File descriptor usage | warn: 70%, crit: 85% |
| `docker` | Unhealthy containers | any unhealthy = warning |

## Installation

```bash
npm install -g agent-awareness-plugin-server-health
```

The agent-awareness loader auto-discovers `agent-awareness-plugin-*` packages from both global and local `node_modules/`.

## Triggers

| Trigger | Default | Description |
|---------|---------|-------------|
| `session-start` | **`full`** | Full status report for all metrics at session start |
| `interval:2m` | **`alerts`** | State-transition alerts only (breaches and recoveries); silent when healthy |

## Configuration

Create `~/.config/agent-awareness/plugins.d/server-health.json`:

```json
{
  "enabled": true,
  "diskPaths": ["/"],
  "metrics": {
    "disk": {
      "enabled": true,
      "thresholds": { "warning": 80, "critical": 90, "hysteresis": 5 },
      "cooldownSeconds": 600
    },
    "memory": {
      "enabled": true,
      "thresholds": { "warning": 80, "critical": 90, "hysteresis": 5 },
      "cooldownSeconds": 300
    }
  },
  "triggers": {
    "session-start": "full",
    "interval:2m": "alerts"
  }
}
```

### Per-metric config

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable this metric |
| `thresholds.warning` | `number` | varies | Warning threshold (%) |
| `thresholds.critical` | `number` | varies | Critical threshold (%) |
| `thresholds.hysteresis` | `number` | `5` | Recovery band — must drop below (threshold - hysteresis) to recover |
| `cooldownSeconds` | `number` | `300` | Min seconds between alerts for same metric |

### Hysteresis explained

With `warning: 80` and `hysteresis: 5`:
- Alert triggers at **80%** (first time)
- Recovery only triggers when dropping below **75%** (80 - 5)
- Values between 75-80% maintain current state — no alert storm

### Cooldown explained

With `cooldownSeconds: 300`:
- After an alert fires, no new alert for 5 minutes even if metric oscillates
- Prevents: "memory 81% WARNING → memory 79% RECOVERED → memory 81% WARNING → ..."

## Output examples

**Session start (full):**
```
Server health:
🟢 Disk: 50%
🟢 Memory: 32%
🟢 Swap: 0%
🟢 CPU Load: 3% (per-CPU)
🟢 Open Files: 0%
🟢 Docker (2 containers): 0 unhealthy
```

**Alert (threshold breach):**
```
Server: 🟡 WARNING: Memory at 82%
```

**Alert (critical):**
```
Server: 🔴 CRITICAL: Disk at 92%
```

**Recovery:**
```
Server: 🟢 RECOVERED: Memory back to 74%
```

**Multiple alerts:**
```
Server: 🔴 CRITICAL: Disk at 95% | 🟡 WARNING: Memory at 83%
```

## Requirements

- Linux (uses `/proc/sys/fs/file-nr`, `free`)
- Docker CLI (optional — docker metric auto-disables if not available)
- agent-awareness v0.1.0+

## License

MIT
