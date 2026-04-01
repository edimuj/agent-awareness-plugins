import test from 'node:test';
import assert from 'node:assert/strict';

import { pluginUrl, testContext } from './helpers.ts';

let plugin: any;

test.before(async () => {
  plugin = (await import(pluginUrl('focus-timer/src/index.ts'))).default;
});

test('focus-timer break uses previous focus state and increments sessions correctly', async () => {
  const result = await plugin.mcp.tools.find((t: any) => t.name === 'break').handler(
    {},
    { breakMinutes: 7 },
    new AbortController().signal,
    {
      status: 'focus',
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      endsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      focusMinutes: 25,
      breakMinutes: 5,
      sessionsCompleted: 2,
      label: 'refactor',
    },
  );

  assert.match(result.text, /Break started: 7min/);
  assert.equal(result.state?.status, 'break');
  assert.equal(result.state?.sessionsCompleted, 3);
});

test('focus-timer stop preserves completion count from previous state', async () => {
  const result = await plugin.mcp.tools.find((t: any) => t.name === 'stop').handler(
    {},
    {},
    new AbortController().signal,
    {
      status: 'focus',
      startedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      endsAt: new Date(Date.now() - 1 * 60_000).toISOString(),
      focusMinutes: 25,
      breakMinutes: 5,
      sessionsCompleted: 4,
      label: null,
    },
  );

  assert.equal(result.state?.status, 'idle');
  assert.equal(result.state?.sessionsCompleted, 5);
});

test('focus-timer extend requires active focus session', async () => {
  const result = await plugin.mcp.tools.find((t: any) => t.name === 'extend').handler(
    { minutes: 15 },
    {},
    new AbortController().signal,
    {
      status: 'break',
      startedAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      focusMinutes: 25,
      breakMinutes: 5,
      sessionsCompleted: 1,
      label: null,
    },
  );

  assert.match(result.text, /No active focus session to extend/);
  assert.equal(result.state, undefined);
});

test('focus-timer status reports active focus timer from previous state', async () => {
  const now = Date.now();
  const result = await plugin.mcp.tools.find((t: any) => t.name === 'status').handler(
    {},
    {},
    new AbortController().signal,
    {
      status: 'focus',
      startedAt: new Date(now - 10 * 60_000).toISOString(),
      endsAt: new Date(now + 15 * 60_000).toISOString(),
      focusMinutes: 25,
      breakMinutes: 5,
      sessionsCompleted: 2,
      label: 'deep-work',
    },
  );

  assert.match(result.text, /Focus: \d+\/25min \[deep-work\] -- deep work, stay dense and focused/);
  assert.equal(result.state?.status, 'focus');
});

test('focus-timer gather returns null when idle', async () => {
  const result = plugin.gather('prompt', {}, null, testContext());
  assert.equal(result, null);
});
