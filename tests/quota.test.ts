import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { pluginUrl, testContext } from './helpers.ts';

function writeCodexAppServer(binDir: string, usedPercent: number, weeklyPercent: number) {
  fs.mkdirSync(binDir, { recursive: true });
  const binPath = path.join(binDir, 'codex');
  const script = `#!/usr/bin/env bash
set -euo pipefail

if [[ "\${1:-}" != "app-server" ]]; then
  exit 64
fi

if ! IFS= read -r _line; then
  exit 0
fi
printf '%s\\n' '{"jsonrpc":"2.0","id":1,"result":{}}'

if ! IFS= read -r _line; then
  exit 0
fi
printf '%s\\n' '{"jsonrpc":"2.0","id":2,"result":{"rateLimits":{"primary":{"usedPercent":${usedPercent},"resetsAt":1800000000},"secondary":{"usedPercent":${weeklyPercent},"resetsAt":1800000000}}}}'
`;
  fs.writeFileSync(binPath, script, 'utf8');
  fs.chmodSync(binPath, 0o755);
}

test('quota skips Agent Relay codex shim when resolving app-server', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-quota-'));
  const relayBin = path.join(root, '.agent-relay', 'codex', 'bin');
  const realBin = path.join(root, 'real-bin');
  writeCodexAppServer(relayBin, 99, 98);
  writeCodexAppServer(realBin, 42, 24);

  const prevPath = process.env.PATH;
  const prevExplicitCodex = process.env.AGENT_AWARENESS_CODEX_BINARY;
  process.env.PATH = `${relayBin}${path.delimiter}${realBin}${path.delimiter}${prevPath ?? ''}`;
  delete process.env.AGENT_AWARENESS_CODEX_BINARY;

  try {
    const plugin = (await import(pluginUrl('quota/src/index.ts'))).default;
    const result = await plugin.gather(
      'session-start',
      { showResetTime: false },
      undefined,
      { ...testContext(), provider: 'codex' },
    );

    assert.ok(result);
    assert.match(result.text, /5h: 42%/);
    assert.match(result.text, /7d: 24%/);
    assert.doesNotMatch(result.text, /99%|98%/);
  } finally {
    if (prevPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = prevPath;
    }
    if (prevExplicitCodex === undefined) {
      delete process.env.AGENT_AWARENESS_CODEX_BINARY;
    } else {
      process.env.AGENT_AWARENESS_CODEX_BINARY = prevExplicitCodex;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
