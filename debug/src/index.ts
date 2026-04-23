import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AwarenessPlugin, Trigger, PluginConfig, GatherContext } from 'agent-awareness';

const PENDING_FILE = join(homedir(), '.cache', 'agent-awareness', 'debug-pending.json');

interface PendingMessage {
  message: string;
  severity?: 'info' | 'warning' | 'critical';
  timestamp: string;
}

export default {
  name: 'debug',
  description: 'Debug channel pipeline — send test messages via CLI',
  triggers: ['interval:1m'],
  defaults: {
    triggers: {
      'interval:1m': true,
    },
  },

  async gather(_trigger: Trigger, _config: PluginConfig, _prevState, _context: GatherContext) {
    let pending: PendingMessage;
    try {
      const raw = await readFile(PENDING_FILE, 'utf8');
      pending = JSON.parse(raw);
    } catch {
      return { text: '', state: {} };
    }

    // Consume the message
    await unlink(PENDING_FILE).catch(() => {});

    const age = Date.now() - new Date(pending.timestamp).getTime();
    const ageSec = Math.round(age / 1000);

    const text = `[debug] ${pending.message} (latency: ${ageSec}s)`;

    return {
      text,
      state: { lastMessage: pending.message, deliveredAt: new Date().toISOString() },
      severity: pending.severity ?? 'info',
    };
  },
} satisfies AwarenessPlugin;
