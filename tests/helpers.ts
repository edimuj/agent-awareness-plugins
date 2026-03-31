import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(TEST_DIR, '..');

export function pluginUrl(relPathFromRoot: string): string {
  const abs = path.resolve(ROOT_DIR, relPathFromRoot);
  const base = pathToFileURL(abs).href;
  return `${base}?t=${Date.now()}-${Math.random()}`;
}

export function testContext() {
  return {
    signal: new AbortController().signal,
    log: { warn: () => {}, error: () => {} },
  };
}

export async function withFakeCommand(
  commandName: string,
  scriptBody: string,
  fn: () => Promise<void>,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aa-test-${commandName}-`));
  const binPath = path.join(dir, commandName);
  const script = `#!/usr/bin/env bash
set -euo pipefail
${scriptBody}
`;
  fs.writeFileSync(binPath, script, 'utf8');
  fs.chmodSync(binPath, 0o755);

  const prevPath = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${prevPath}`;
  try {
    await fn();
  } finally {
    process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
