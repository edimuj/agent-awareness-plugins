/**
 * server-health — agent-awareness provider plugin
 *
 * Threshold-based server health alerts with hysteresis and cooldown.
 * Only reports when a metric crosses a threshold (first time) or recovers.
 * Cooldown prevents alert storms when metrics oscillate around thresholds.
 *
 * Design principles:
 * - Silent when healthy — zero token waste
 * - Alert on threshold breach (once)
 * - Alert on recovery (once)
 * - Cooldown prevents oscillation spam
 * - Hysteresis band: alert at threshold, recover at threshold - hysteresis
 * - Session-start always gets a full status report
 */
import { freemem, totalmem, loadavg, cpus } from 'node:os';
import { statfs } from 'node:fs/promises';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AwarenessPlugin,
  GatherContext,
  GatherResult,
  PluginConfig,
  Trigger,
} from 'agent-awareness';

const exec = promisify(execCb);

// ── Types ──────────────────────────────────────────────────────────────────

type MetricStatus = 'normal' | 'warning' | 'critical';

interface MetricState {
  status: MetricStatus;
  /** ISO timestamp when current status was entered */
  since: string;
  /** ISO timestamp of last alert sent for this metric */
  lastAlertAt: string;
  /** The value when last alert was sent */
  lastAlertValue: number;
}

interface HealthState extends Record<string, unknown> {
  metrics: Record<string, MetricState>;
  /** ISO timestamp of first gather (used for session-start detection) */
  initialized: string;
}

interface MetricReading {
  name: string;
  label: string;
  value: number;
  unit: string;
  status: MetricStatus;
  prevStatus: MetricStatus;
  transition: 'none' | 'escalated' | 'recovered';
  cooldownActive: boolean;
}

interface ThresholdConfig {
  warning: number;
  critical: number;
  /** Hysteresis band — recover at (threshold - hysteresis) */
  hysteresis: number;
}

interface MetricConfig {
  enabled: boolean;
  thresholds: ThresholdConfig;
  /** Cooldown in seconds — suppress repeated alerts within this window */
  cooldownSeconds: number;
}

// ── Metric collectors ──────────────────────────────────────────────────────

async function collectDiskUsage(path: string): Promise<number> {
  const stats = await statfs(path);
  const total = stats.blocks * stats.bsize;
  const free = stats.bavail * stats.bsize;
  return Math.round((1 - free / total) * 100);
}

function collectMemoryUsage(): number {
  const total = totalmem();
  const free = freemem();
  return Math.round((1 - free / total) * 100);
}

function collectLoadAvg(): number {
  const load = loadavg()[0];
  const numCpus = cpus().length;
  // Normalize: load per CPU as percentage (1.0 per CPU = 100%)
  return Math.round((load / numCpus) * 100);
}

async function collectSwapUsage(signal?: AbortSignal): Promise<number> {
  try {
    const { stdout } = await exec("free -b | awk '/Swap:/ {if($2>0) print int(($3/$2)*100); else print 0}'", { signal });
    return parseInt(stdout.trim(), 10) || 0;
  } catch { return 0; }
}

async function collectDockerHealth(signal?: AbortSignal): Promise<{ total: number; unhealthy: string[] }> {
  try {
    const { stdout } = await exec(
      'sg docker -c \'docker ps --format "{{.Names}}\\t{{.Status}}"\' 2>/dev/null',
      { signal, env: { ...process.env, PATH: process.env.PATH + ':/usr/bin:/usr/local/bin' } },
    );
    if (!stdout.trim()) return { total: 0, unhealthy: [] };
    const lines = stdout.trim().split('\n');
    const unhealthy = lines
      .filter((l) => /unhealthy|restarting|dead|exited/i.test(l))
      .map((l) => l.split('\t')[0]!);
    return { total: lines.length, unhealthy };
  } catch { return { total: 0, unhealthy: [] }; }
}

async function collectOpenFiles(signal?: AbortSignal): Promise<number> {
  try {
    const { stdout } = await exec("cat /proc/sys/fs/file-nr | awk '{print int(($1/$3)*100)}'", { signal });
    return parseInt(stdout.trim(), 10) || 0;
  } catch { return 0; }
}

// ── Status evaluation ──────────────────────────────────────────────────────

function evaluateStatus(
  value: number,
  thresholds: ThresholdConfig,
  prevStatus: MetricStatus,
): MetricStatus {
  const { warning, critical, hysteresis } = thresholds;

  // Recovery/escalation from critical uses the critical hysteresis band.
  if (prevStatus === 'critical') {
    if (value >= (critical - hysteresis)) return 'critical';
    if (value >= warning) return 'warning';
    return 'normal';
  }
  // Recovery/escalation from warning uses the warning hysteresis band.
  if (prevStatus === 'warning') {
    if (value >= critical) return 'critical';
    if (value >= (warning - hysteresis)) return 'warning';
    return 'normal';
  }

  // Escalation from normal uses exact thresholds.
  if (value >= critical) return 'critical';
  if (value >= warning) return 'warning';
  return 'normal';
}

function shouldAlert(
  reading: MetricReading,
  metricState: MetricState,
  cooldownSeconds: number,
): boolean {
  if (reading.transition === 'recovered') {
    return true;
  }
  if (reading.transition === 'escalated') {
    if (metricState.lastAlertAt) {
      const elapsed = (Date.now() - new Date(metricState.lastAlertAt).getTime()) / 1000;
      if (elapsed < cooldownSeconds) return false;
    }
    return true;
  }
  return false;
}

// ── Formatters ─────────────────────────────────────────────────────────────

function formatFullStatus(readings: MetricReading[]): string {
  const lines = readings.map((r) => {
    const icon = r.status === 'critical' ? '🔴' : r.status === 'warning' ? '🟡' : '🟢';
    return `${icon} ${r.label}: ${r.value}${r.unit}`;
  });
  return `Server health:\n${lines.join('\n')}`;
}

function formatAlert(reading: MetricReading): string {
  if (reading.transition === 'escalated') {
    const icon = reading.status === 'critical' ? '🔴 CRITICAL' : '🟡 WARNING';
    return `${icon}: ${reading.label} at ${reading.value}${reading.unit}`;
  }
  if (reading.transition === 'recovered') {
    return `🟢 RECOVERED: ${reading.label} back to ${reading.value}${reading.unit}`;
  }
  return '';
}

function formatAlerts(readings: MetricReading[]): string {
  const alerts = readings
    .filter((r) => r.transition !== 'none')
    .map(formatAlert)
    .filter(Boolean);
  return alerts.length > 0 ? `Server: ${alerts.join(' | ')}` : '';
}

// ── Core collection ────────────────────────────────────────────────────────

async function collectAllMetrics(
  config: PluginConfig,
  prevState: HealthState | null,
  signal?: AbortSignal,
): Promise<{ readings: MetricReading[]; newState: HealthState }> {
  const metricsConfig = (config.metrics ?? {}) as Record<string, Partial<MetricConfig>>;
  const diskPaths = (config.diskPaths as string[]) ?? ['/'];
  const now = new Date().toISOString();

  const state: HealthState = prevState ?? {
    metrics: {},
    initialized: now,
  };

  const readings: MetricReading[] = [];

  function collectReading(
    key: string,
    label: string,
    value: number,
    unit: string,
    mc: MetricConfig,
  ) {
    const prev = state.metrics[key] ?? { status: 'normal' as MetricStatus, since: now, lastAlertAt: '', lastAlertValue: 0 };
    const status = evaluateStatus(value, mc.thresholds, prev.status);
    const transition: MetricReading['transition'] = status !== prev.status
      ? (statusSeverity(status) > statusSeverity(prev.status) ? 'escalated' : 'recovered')
      : 'none';

    const reading: MetricReading = {
      name: key,
      label,
      value,
      unit,
      status,
      prevStatus: prev.status,
      transition,
      cooldownActive: false,
    };

    reading.cooldownActive = !shouldAlert(reading, prev, mc.cooldownSeconds) && transition !== 'none';
    readings.push(reading);
  }

  // Disk
  if (metricsConfig.disk?.enabled) {
    const mc = mergeMetricConfig(defaultMetricConfig, metricsConfig.disk);
    for (const diskPath of diskPaths) {
      try {
        const value = await collectDiskUsage(diskPath);
        collectReading(`disk:${diskPath}`, diskPaths.length > 1 ? `Disk (${diskPath})` : 'Disk', value, '%', mc);
      } catch { /* skip */ }
    }
  }

  // Memory
  if (metricsConfig.memory?.enabled) {
    const mc = mergeMetricConfig(defaultMetricConfig, metricsConfig.memory);
    collectReading('memory', 'Memory', collectMemoryUsage(), '%', mc);
  }

  // Swap
  if (metricsConfig.swap?.enabled) {
    const mc = mergeMetricConfig(swapMetricDefaults, metricsConfig.swap);
    collectReading('swap', 'Swap', await collectSwapUsage(signal), '%', mc);
  }

  // Load
  if (metricsConfig.load?.enabled) {
    const mc = mergeMetricConfig(loadMetricDefaults, metricsConfig.load);
    collectReading('load', 'CPU Load', collectLoadAvg(), '% (per-CPU)', mc);
  }

  // Open files
  if (metricsConfig.openFiles?.enabled) {
    const mc = mergeMetricConfig(openFilesMetricDefaults, metricsConfig.openFiles);
    collectReading('openFiles', 'Open Files', await collectOpenFiles(signal), '%', mc);
  }

  // Docker
  if (metricsConfig.docker?.enabled) {
    const mc = mergeMetricConfig(dockerMetricDefaults, metricsConfig.docker);
    const docker = await collectDockerHealth(signal);
    const value = docker.unhealthy.length;
    const label = value > 0
      ? `Docker (${docker.unhealthy.join(', ')})`
      : `Docker (${docker.total} containers)`;
    collectReading('docker', label, value, ' unhealthy', mc);
  }

  // Update state
  const newState: HealthState = {
    metrics: { ...state.metrics },
    initialized: state.initialized,
  };

  for (const reading of readings) {
    const prev = state.metrics[reading.name];
    newState.metrics[reading.name] = {
      status: reading.status,
      since: reading.transition !== 'none' ? now : (prev?.since ?? now),
      lastAlertAt: (reading.transition !== 'none' && !reading.cooldownActive)
        ? now
        : (prev?.lastAlertAt ?? ''),
      lastAlertValue: reading.value,
    };
  }

  return { readings, newState };
}

// ── Plugin ─────────────────────────────────────────────────────────────────

const defaultMetricConfig: MetricConfig = {
  enabled: true,
  thresholds: { warning: 80, critical: 90, hysteresis: 5 },
  cooldownSeconds: 300,
};

const swapMetricDefaults: MetricConfig = {
  ...defaultMetricConfig,
  thresholds: { warning: 60, critical: 80, hysteresis: 10 },
};

const loadMetricDefaults: MetricConfig = {
  ...defaultMetricConfig,
  thresholds: { warning: 150, critical: 250, hysteresis: 20 },
  cooldownSeconds: 120,
};

const openFilesMetricDefaults: MetricConfig = {
  enabled: true,
  thresholds: { warning: 70, critical: 85, hysteresis: 5 },
  cooldownSeconds: 300,
};

const dockerMetricDefaults: MetricConfig = {
  enabled: true,
  thresholds: { warning: 1, critical: 3, hysteresis: 1 },
  cooldownSeconds: 300,
};

function mergeMetricConfig(
  defaults: MetricConfig,
  override?: Partial<MetricConfig>,
): MetricConfig {
  const thresholdsOverride = (override?.thresholds ?? {}) as Partial<ThresholdConfig>;
  return {
    ...defaults,
    ...override,
    thresholds: {
      ...defaults.thresholds,
      ...thresholdsOverride,
    },
  };
}

function statusSeverity(status: MetricStatus): number {
  if (status === 'critical') return 2;
  if (status === 'warning') return 1;
  return 0;
}

export default {
  name: 'server-health',
  description: 'Server health threshold alerts with hysteresis and cooldown — only reports state changes',

  triggers: ['session-start', 'interval:2m'],

  defaults: {
    enabled: true,
    /** Disk paths to monitor */
    diskPaths: ['/'],
    /** Per-metric configuration */
    metrics: {
      disk: { ...defaultMetricConfig },
      memory: { ...defaultMetricConfig },
      swap: {
        ...swapMetricDefaults,
      },
      load: {
        ...loadMetricDefaults,
      },
      openFiles: {
        ...openFilesMetricDefaults,
      },
      docker: {
        ...dockerMetricDefaults,
      },
    },
    triggers: {
      'session-start': 'full',
      'interval:2m': 'alerts',
    },
  },

  async gather(
    trigger: Trigger,
    config: PluginConfig,
    prevState: HealthState | null,
    context: GatherContext,
  ): Promise<GatherResult<HealthState> | null> {
    const { readings, newState } = await collectAllMetrics(config, prevState, context.signal);

    const triggerFormat = config.triggers?.[trigger as string];
    const isFullReport = triggerFormat === 'full' || trigger === 'session-start';

    if (isFullReport) {
      return { text: formatFullStatus(readings), state: newState };
    }

    // Alert mode: only report transitions that aren't cooldown-suppressed
    let alertableReadings = readings.filter((r) => r.transition !== 'none' && !r.cooldownActive);

    // Claim alerts to prevent duplicate action across concurrent sessions
    if (context.claims && alertableReadings.length > 0) {
      const claimed: MetricReading[] = [];
      for (const reading of alertableReadings) {
        const claimKey = `${reading.name}:${reading.transition}:${reading.status}`;
        const { claimed: ok } = await context.claims.tryClaim(claimKey, 10);
        if (ok) {
          claimed.push(reading);
        }
      }
      alertableReadings = claimed;
    }

    const text = formatAlerts(alertableReadings);

    if (!text) {
      return { text: '', state: newState };
    }

    return { text, state: newState };
  },

  mcp: {
    tools: [
      {
        name: 'status',
        description: 'Get full server health status right now — all metrics with current values and threshold states',
        inputSchema: { type: 'object' as const },
        async handler(
          _params: Record<string, unknown>,
          config: PluginConfig,
          signal: AbortSignal,
          prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const { readings, newState } = await collectAllMetrics(config, prevState as HealthState | null, signal);
          return { text: formatFullStatus(readings), state: newState };
        },
      },
      {
        name: 'acknowledge',
        description: 'Acknowledge a warning — resets the cooldown timer for a metric so it won\'t re-alert until a new transition',
        inputSchema: {
          type: 'object' as const,
          properties: {
            metric: {
              type: 'string',
              description: 'Metric name to acknowledge (disk:/, memory, swap, load, openFiles, docker)',
            },
          },
          required: ['metric'],
        },
        async handler(
          params: Record<string, unknown>,
          _config: PluginConfig,
          _signal: AbortSignal,
          prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const metric = params.metric as string;
          const state = (prevState as HealthState | null) ?? { metrics: {}, initialized: new Date().toISOString() };

          if (!state.metrics[metric]) {
            return { text: `Unknown metric: ${metric}` };
          }

          // Set last alert time to now — starts a fresh cooldown window
          const newState: HealthState = {
            ...state,
            metrics: {
              ...state.metrics,
              [metric]: {
                ...state.metrics[metric],
                lastAlertAt: new Date().toISOString(),
              },
            },
          };

          return {
            text: `Acknowledged: ${metric} (status: ${state.metrics[metric].status})`,
            state: newState,
          };
        },
      },
    ],
  },
} satisfies AwarenessPlugin<HealthState>;
