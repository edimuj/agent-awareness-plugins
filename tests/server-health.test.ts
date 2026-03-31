import assert from 'node:assert/strict';
import test from 'node:test';

import { pluginUrl, testContext, withFakeCommand } from './helpers.ts';

test('server-health keeps critical status within critical hysteresis band', async () => {
  await withFakeCommand(
    'sg',
    `
# Called as: sg docker -c 'docker ps --format "{{.Names}}\t{{.Status}}"'
cat <<'OUT'
svc-a	Up 1 minute (unhealthy)
svc-b	Up 1 minute (unhealthy)
OUT
`,
    async () => {
      const plugin = (await import(pluginUrl('server-health/src/index.ts'))).default;
      const result = await plugin.gather(
        'interval:2m',
        {
          diskPaths: ['/'],
          metrics: {
            docker: {
              enabled: true,
              thresholds: { warning: 1, critical: 3, hysteresis: 1 },
              cooldownSeconds: 0,
            },
          },
          triggers: { 'interval:2m': 'alerts' },
        },
        {
          metrics: {
            docker: {
              status: 'critical',
              since: '2026-03-30T00:00:00.000Z',
              lastAlertAt: '',
              lastAlertValue: 3,
            },
          },
          initialized: '2026-03-30T00:00:00.000Z',
        },
        testContext(),
      );

      assert.ok(result);
      assert.equal(result.state.metrics.docker.status, 'critical');
      assert.equal(result.text, '');
    },
  );
});
