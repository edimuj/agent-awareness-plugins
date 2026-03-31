import assert from 'node:assert/strict';
import test from 'node:test';

import { pluginUrl, testContext, withFakeCommand } from './helpers.ts';

test('github-watcher formats null-author comments as @unknown', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "issue list" ]]; then
  echo '[]'
  exit 0
fi
if [[ "$1 $2" == "pr list" ]]; then
  echo '[]'
  exit 0
fi
if [[ "$1 $2" == "api graphql" ]]; then
  cat <<'JSON'
{"data":{"repository":{"issueComments":{"nodes":[{"number":12,"title":"Issue title","comments":{"nodes":[{"author":null,"body":"nullable author comment","createdAt":"2026-03-30T10:00:00Z","url":"https://github.com/acme/ext/issues/12#issuecomment-1"}]}}]},"prComments":{"nodes":[]}}}}
JSON
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
    async () => {
      const plugin = (await import(pluginUrl('github-watcher/src/index.ts'))).default;
      const result = await plugin.gather(
        'session-start',
        {
          repos: ['acme/ext'],
          ignoreAuthors: [],
          commentLimit: 10,
          triggers: { 'session-start': 'detailed' },
        },
        {
          repos: {
            'acme/ext': {
              lastIssueId: 0,
              lastPrId: 0,
              lastIssueAt: '2026-03-01T00:00:00.000Z',
              lastPrAt: '2026-03-01T00:00:00.000Z',
              lastCommentAt: '2026-03-01T00:00:00.000Z',
            },
          },
          lastCheck: '2026-03-01T00:00:00.000Z',
        },
        testContext(),
      );

      assert.ok(result);
      assert.match(result.text, /@unknown: nullable author comment/);
    },
  );
});

test('github-watcher check --since does not mutate persisted repo cursors', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "issue list" ]]; then
  echo '[]'
  exit 0
fi
if [[ "$1 $2" == "pr list" ]]; then
  echo '[]'
  exit 0
fi
if [[ "$1 $2" == "api graphql" ]]; then
  cat <<'JSON'
{"data":{"repository":{"issueComments":{"nodes":[]},"prComments":{"nodes":[]}}}}
JSON
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
    async () => {
      const plugin = (await import(pluginUrl('github-watcher/src/index.ts'))).default;
      const checkTool = plugin.mcp.tools.find((tool: { name: string }) => tool.name === 'check');
      assert.ok(checkTool);

      const prevState = {
        repos: {
          'acme/ext': {
            lastIssueId: 99,
            lastPrId: 10,
            lastIssueAt: '2020-01-01T00:00:00.000Z',
            lastPrAt: '2020-01-01T00:00:00.000Z',
            lastCommentAt: '2020-01-01T00:00:00.000Z',
          },
        },
        lastCheck: '2020-01-01T00:00:00.000Z',
      };

      const result = await checkTool.handler(
        { repo: 'acme/ext', since: '2026-03-01T00:00:00.000Z' },
        { repos: ['acme/ext'], ignoreAuthors: [], commentLimit: 10 },
        new AbortController().signal,
        prevState,
      );

      assert.ok(result);
      const next = result.state as typeof prevState;
      assert.equal(next.repos['acme/ext'].lastIssueAt, '2020-01-01T00:00:00.000Z');
      assert.equal(next.repos['acme/ext'].lastPrAt, '2020-01-01T00:00:00.000Z');
      assert.equal(next.repos['acme/ext'].lastCommentAt, '2020-01-01T00:00:00.000Z');
    },
  );
});
