import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { promisify } from 'node:util';

import { pluginUrl, testContext, withFakeCommand } from './helpers.ts';

const exec = promisify(execFile);

function ghScriptForRunMap(runMapJson: string): string {
  return `
if [[ "$1 $2" == "repo list" ]]; then
  echo 'alice/repo1'
  exit 0
fi
if [[ "$1 $2" == "run list" ]]; then
  repo=''
  prev=''
  for arg in "$@"; do
    if [[ "$prev" == "--repo" ]]; then
      repo="$arg"
      break
    fi
    prev="$arg"
  done
  case "$repo" in
    alice/repo1) cat <<'JSON'
${runMapJson}
JSON
      ;;
    alice/repoA) echo '[]' ;;
    alice/repoB) cat <<'JSON'
[{"databaseId":200,"workflowName":"ci","name":"ci","status":"completed","conclusion":"failure","headBranch":"main","event":"push","createdAt":"2026-03-31T09:00:00Z","updatedAt":"2026-03-31T09:10:00Z","url":"https://example.com/repoB/200"}]
JSON
      ;;
    *) echo '[]' ;;
  esac
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`;
}

test('actions-watcher should persist discovered repos even when everything is green', async () => {
  await withFakeCommand(
    'gh',
    ghScriptForRunMap(
      '[{"databaseId":101,"workflowName":"ci","name":"ci","status":"completed","conclusion":"success","headBranch":"main","event":"push","createdAt":"2026-03-31T09:00:00Z","updatedAt":"2026-03-31T09:10:00Z","url":"https://example.com/repo1/101"}]',
    ),
    async () => {
      const plugin = (await import(pluginUrl('actions-watcher/src/index.ts'))).default;
      const result = await plugin.gather(
        'session-start',
        {
          owner: 'alice',
          repos: [],
          maxAgeDays: 14,
          autonomy: 'report',
          workflowFilter: [],
          branchFilter: [],
          limit: 10,
        },
        null,
        testContext(),
      );

      assert.ok(result, 'expected non-null result so discovered repo state persists');
      assert.deepEqual(result.state.discoveredRepos, ['alice/repo1']);
    },
  );
});

test('actions-watcher should clear stale workflow state for repos with no latest runs (claims path)', async () => {
  await withFakeCommand(
    'gh',
    ghScriptForRunMap(
      '[{"databaseId":102,"workflowName":"ci","name":"ci","status":"completed","conclusion":"failure","headBranch":"main","event":"push","createdAt":"2026-03-31T09:00:00Z","updatedAt":"2026-03-31T09:10:00Z","url":"https://example.com/repo1/102"}]',
    ),
    async () => {
      const plugin = (await import(pluginUrl('actions-watcher/src/index.ts'))).default;
      const result = await plugin.gather(
        'interval:5m',
        {
          repos: ['alice/repoA', 'alice/repoB'],
          maxAgeDays: 14,
          autonomy: 'report',
          workflowFilter: [],
          branchFilter: [],
          limit: 10,
        },
        {
          repos: {
            'alice/repoA': {
              workflows: {
                ci: {
                  workflowName: 'ci',
                  conclusion: 'failure',
                  runId: 10,
                  branch: 'main',
                  event: 'push',
                  updatedAt: '2026-03-20T09:00:00Z',
                  url: 'https://example.com/repoA/10',
                },
              },
              lastCheckedRunId: 10,
            },
          },
        },
        {
          ...testContext(),
          claims: {
            tryClaim: async () => ({ claimed: true }),
          },
        },
      );

      assert.ok(result);
      assert.equal(result.state.repos['alice/repoA']?.workflows?.ci, undefined);
    },
  );
});

test('actions-watcher should classify failure after cancelled as FAILED (not still failing)', async () => {
  await withFakeCommand(
    'gh',
    ghScriptForRunMap(
      '[{"databaseId":2,"workflowName":"ci","name":"ci","status":"completed","conclusion":"failure","headBranch":"main","event":"push","createdAt":"2026-03-31T09:00:00Z","updatedAt":"2026-03-31T09:10:00Z","url":"https://example.com/repo1/2"}]',
    ),
    async () => {
      const plugin = (await import(pluginUrl('actions-watcher/src/index.ts'))).default;
      const result = await plugin.gather(
        'interval:5m',
        {
          repos: ['alice/repo1'],
          maxAgeDays: 14,
          autonomy: 'report',
          workflowFilter: [],
          branchFilter: [],
          limit: 10,
        },
        {
          repos: {
            'alice/repo1': {
              workflows: {
                ci: {
                  workflowName: 'ci',
                  conclusion: 'cancelled',
                  runId: 1,
                  branch: 'main',
                  event: 'push',
                  updatedAt: '2026-03-30T09:00:00Z',
                  url: 'https://example.com/repo1/1',
                },
              },
              lastCheckedRunId: 1,
            },
          },
        },
        testContext(),
      );

      assert.ok(result);
      assert.match(result.text, /FAILED:/);
      assert.doesNotMatch(result.text, /still failing/i);
    },
  );
});

test('actions-watcher d.ts should keep runs.limit input type as number', async () => {
  await exec('npm', ['run', 'build']);
  const dts = await readFile(new URL('../actions-watcher/src/index.d.ts', import.meta.url), 'utf8');
  assert.match(dts, /limit:\s*\{\s*type:\s*"number"/s);
});
