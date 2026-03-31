/**
 * claim-debugger — agent-awareness test/debug plugin
 *
 * MCP-tool-only plugin for testing multi-agent coordination.
 * No triggers — invoked entirely on demand via MCP tools.
 *
 * Tools:
 *   simulate  — fire a fake event into a plugin's claim space
 *   contend   — create a claim as-if from a foreign session (tests downgrade path)
 *   release   — release a claim held by this or any session
 *   claims    — list all active claims across all plugins
 *   clear     — wipe all claims (nuclear reset)
 */

import { readdir, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import type {
  AwarenessPlugin,
  GatherContext,
  GatherResult,
  PluginConfig,
  Trigger,
} from 'agent-awareness';
import { CLAIMS_DIR, createClaimContext } from 'agent-awareness';
import type { ClaimInfo } from 'agent-awareness';

// ── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeKey(eventKey: string): string {
  return eventKey.replace(/[/\\#:]/g, '_');
}

async function readClaim(path: string): Promise<ClaimInfo | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function getAllClaims(): Promise<Array<{ plugin: string; eventKey: string; claim: ClaimInfo; expired: boolean; alive: boolean }>> {
  const results: Array<{ plugin: string; eventKey: string; claim: ClaimInfo; expired: boolean; alive: boolean }> = [];

  let pluginDirs: string[];
  try {
    pluginDirs = await readdir(CLAIMS_DIR);
  } catch {
    return results;
  }

  for (const dir of pluginDirs) {
    const dirPath = join(CLAIMS_DIR, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const claim = await readClaim(join(dirPath, file));
      if (!claim) continue;

      const expired = Date.now() > new Date(claim.expiresAt).getTime();
      let alive = true;
      if (claim.holder.startsWith(hostname() + ':')) {
        try {
          process.kill(claim.pid, 0);
        } catch (err: unknown) {
          alive = (err as NodeJS.ErrnoException).code === 'EPERM';
        }
      }

      results.push({
        plugin: dir,
        eventKey: file.replace('.json', ''),
        claim,
        expired,
        alive,
      });
    }
  }

  return results;
}

// ── Plugin ───────────────────────────────────────────────────────────────────

export default {
  name: 'claim-debugger',
  description: 'Debug and test the multi-agent event claiming system',

  triggers: [],
  defaults: { enabled: true, triggers: {} },

  gather(
    _trigger: Trigger,
    _config: PluginConfig,
    _prevState: Record<string, unknown> | null,
    _context: GatherContext,
  ): GatherResult | null {
    return null; // MCP-only plugin
  },

  mcp: {
    tools: [
      // ── simulate: fire a fake event claim ────────────────────────────────
      {
        name: 'simulate',
        description: 'Simulate an event by creating a claim as this session. Tests that the claiming path works and that this session would "own" the event.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            plugin: {
              type: 'string',
              description: 'Plugin name to simulate for (e.g., "pr-pilot", "server-health", "github-watcher")',
            },
            event: {
              type: 'string',
              description: 'Event key to claim (e.g., "vercel/next.js#4521:checks_failed", "memory:escalated:critical")',
            },
            ttl: {
              type: 'number',
              description: 'Claim TTL in minutes (default: 5)',
            },
          },
          required: ['plugin', 'event'],
        },
        async handler(
          params: Record<string, unknown>,
          _config: PluginConfig,
          _signal: AbortSignal,
          _prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const plugin = params.plugin as string;
          const event = params.event as string;
          const ttl = (params.ttl as number) ?? 5;

          const ctx = createClaimContext(plugin);
          const result = await ctx.tryClaim(event, ttl);

          if (result.claimed) {
            return { text: `Claimed ${plugin}:${event} (TTL: ${ttl}min, holder: ${hostname()}:${process.pid})` };
          }
          return { text: `Claim denied — held by ${result.holder}` };
        },
      },

      // ── contend: fake a foreign claim to test downgrade ──────────────────
      {
        name: 'contend',
        description: 'Create a claim as-if from a different session (fake PID). Tests the "being handled by another session" downgrade path in other plugins.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            plugin: {
              type: 'string',
              description: 'Plugin name (e.g., "pr-pilot")',
            },
            event: {
              type: 'string',
              description: 'Event key to contend (e.g., "vercel/next.js#4521:checks_failed")',
            },
            ttl: {
              type: 'number',
              description: 'Claim TTL in minutes (default: 30)',
            },
          },
          required: ['plugin', 'event'],
        },
        async handler(
          params: Record<string, unknown>,
          _config: PluginConfig,
          _signal: AbortSignal,
          _prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const plugin = params.plugin as string;
          const event = params.event as string;
          const ttl = (params.ttl as number) ?? 30;

          // Write claim file directly with a fake PID (PID 1 = init, always alive)
          const claimDir = join(CLAIMS_DIR, plugin);
          const claimFile = join(claimDir, `${sanitizeKey(event)}.json`);
          const now = new Date();
          const info: ClaimInfo = {
            holder: `${hostname()}:1`,
            pid: 1,
            claimedAt: now.toISOString(),
            expiresAt: new Date(now.getTime() + ttl * 60_000).toISOString(),
          };

          await mkdir(claimDir, { recursive: true });
          await writeFile(claimFile, JSON.stringify(info, null, 2) + '\n');

          return {
            text: `Contended ${plugin}:${event} as fake session ${hostname()}:1 (TTL: ${ttl}min)\n`
              + `Other sessions will now see "being handled by another session" for this event.\n`
              + `Use \`release\` tool with force:true to clean up.`,
          };
        },
      },

      // ── release: remove a claim ──────────────────────────────────────────
      {
        name: 'release',
        description: 'Release a claim. By default only releases claims owned by this session. Use force:true to release any claim (including contended ones).',
        inputSchema: {
          type: 'object' as const,
          properties: {
            plugin: {
              type: 'string',
              description: 'Plugin name',
            },
            event: {
              type: 'string',
              description: 'Event key to release',
            },
            force: {
              type: 'boolean',
              description: 'Force-release even if claimed by another session (default: false)',
            },
          },
          required: ['plugin', 'event'],
        },
        async handler(
          params: Record<string, unknown>,
          _config: PluginConfig,
          _signal: AbortSignal,
          _prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const plugin = params.plugin as string;
          const event = params.event as string;
          const force = params.force === true;

          const claimFile = join(CLAIMS_DIR, plugin, `${sanitizeKey(event)}.json`);
          const existing = await readClaim(claimFile);

          if (!existing) {
            return { text: `No claim found for ${plugin}:${event}` };
          }

          const isOurs = existing.holder === `${hostname()}:${process.pid}`;

          if (!isOurs && !force) {
            return { text: `Claim held by ${existing.holder} — use force:true to override` };
          }

          await rm(claimFile, { force: true });
          return { text: `Released ${plugin}:${event} (was held by ${existing.holder})` };
        },
      },

      // ── claims: list all active claims ───────────────────────────────────
      {
        name: 'claims',
        description: 'List all active claims across all plugins. Shows holder, expiry, and liveness status.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            plugin: {
              type: 'string',
              description: 'Filter by plugin name (optional)',
            },
            all: {
              type: 'boolean',
              description: 'Include expired claims (default: false)',
            },
          },
        },
        async handler(
          params: Record<string, unknown>,
          _config: PluginConfig,
          _signal: AbortSignal,
          _prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const filterPlugin = params.plugin as string | undefined;
          const showAll = params.all === true;

          let claims = await getAllClaims();

          if (filterPlugin) {
            claims = claims.filter((c) => c.plugin === filterPlugin);
          }
          if (!showAll) {
            claims = claims.filter((c) => !c.expired);
          }

          if (claims.length === 0) {
            return { text: filterPlugin ? `No active claims for ${filterPlugin}` : 'No active claims' };
          }

          const isUs = `${hostname()}:${process.pid}`;
          const lines = claims.map((c) => {
            const owner = c.claim.holder === isUs ? 'this session' : c.claim.holder;
            const status: string[] = [];
            if (c.expired) status.push('EXPIRED');
            if (!c.alive) status.push('DEAD PID');
            if (c.claim.holder === isUs) status.push('OURS');
            const statusStr = status.length > 0 ? ` [${status.join(', ')}]` : '';
            const ttlLeft = Math.max(0, Math.round((new Date(c.claim.expiresAt).getTime() - Date.now()) / 60_000));
            return `  ${c.plugin}:${c.eventKey} — ${owner} (${ttlLeft}min left)${statusStr}`;
          });

          return { text: `Active claims (${claims.length}):\n${lines.join('\n')}` };
        },
      },

      // ── clear: wipe all claims ───────────────────────────────────────────
      {
        name: 'clear',
        description: 'Remove ALL claims across all plugins. Nuclear reset — use when testing is done or claims are in a bad state.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            plugin: {
              type: 'string',
              description: 'Only clear claims for this plugin (optional — omit to clear everything)',
            },
          },
        },
        async handler(
          params: Record<string, unknown>,
          _config: PluginConfig,
          _signal: AbortSignal,
          _prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const filterPlugin = params.plugin as string | undefined;

          if (filterPlugin) {
            const dirPath = join(CLAIMS_DIR, filterPlugin);
            await rm(dirPath, { recursive: true, force: true });
            return { text: `Cleared all claims for ${filterPlugin}` };
          }

          await rm(CLAIMS_DIR, { recursive: true, force: true });
          return { text: 'Cleared ALL claims across all plugins' };
        },
      },
    ],
  },
} satisfies AwarenessPlugin;
