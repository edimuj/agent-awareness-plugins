#!/usr/bin/env node

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const PENDING_FILE = join(homedir(), '.cache', 'agent-awareness', 'debug-pending.json');
const STATE_DIR = join(homedir(), '.cache', 'agent-awareness');

const args = process.argv.slice(2);
const command = args[0];

if (command === 'send') {
  const message = args.slice(1).join(' ');
  if (!message) {
    console.error('Usage: agent-awareness-debug send <message> [--severity info|warning|critical]');
    process.exit(2);
  }

  // Parse optional --severity flag
  const sevIdx = args.indexOf('--severity');
  let severity: string | undefined;
  let msg = message;
  if (sevIdx !== -1) {
    severity = args[sevIdx + 1];
    msg = args.slice(1, sevIdx).join(' ');
  }

  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(PENDING_FILE, JSON.stringify({
    message: msg,
    severity,
    timestamp: new Date().toISOString(),
  }) + '\n');

  console.log(`Queued: "${msg}" — will be picked up within ~1 minute`);
} else {
  console.log('agent-awareness-debug — test the channel pipeline\n');
  console.log('Commands:');
  console.log('  send <message> [--severity info|warning|critical]');
  console.log('\nExample:');
  console.log('  agent-awareness-debug send "Hello from the debug plugin!"');
  console.log('  agent-awareness-debug send "Alert test" --severity critical');
}
