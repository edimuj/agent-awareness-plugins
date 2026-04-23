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

test('github-watcher deduplicates cross-session claims for identical activity', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "issue list" ]]; then
  cat <<'JSON'
[{"number":42,"title":"Bug report","author":{"login":"alice"},"createdAt":"2026-03-30T10:00:00Z","url":"https://github.com/acme/ext/issues/42","state":"OPEN"}]
JSON
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
      const seen = new Set<string>();
      const sharedClaims = {
        tryClaim: async (key: string) => {
          if (seen.has(key)) return { claimed: false };
          seen.add(key);
          return { claimed: true };
        },
      };
      const prevState = {
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
      };

      const first = await plugin.gather(
        'interval:15m',
        { repos: ['acme/ext'], ignoreAuthors: [], commentLimit: 10, onlyWhenNew: true },
        prevState,
        { ...testContext(), claims: sharedClaims },
      );
      assert.ok(first);
      assert.match(first.text, /GitHub:/);

      const second = await plugin.gather(
        'interval:15m',
        { repos: ['acme/ext'], ignoreAuthors: [], commentLimit: 10, onlyWhenNew: true },
        prevState,
        { ...testContext(), claims: sharedClaims },
      );
      assert.ok(second);
      assert.equal(second.text, '');
    },
  );
});

test('github-watcher tolerates null author on issues/PRs without dropping valid items', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "issue list" ]]; then
  cat <<'JSON'
[{"number":1,"title":"Null author issue","author":null,"createdAt":"2026-03-30T10:00:00Z","url":"https://github.com/acme/ext/issues/1","state":"OPEN"},{"number":2,"title":"Valid issue","author":{"login":"bob"},"createdAt":"2026-03-30T10:05:00Z","url":"https://github.com/acme/ext/issues/2","state":"OPEN"}]
JSON
  exit 0
fi
if [[ "$1 $2" == "pr list" ]]; then
  cat <<'JSON'
[{"number":3,"title":"Null author PR","author":null,"createdAt":"2026-03-30T10:10:00Z","url":"https://github.com/acme/ext/pull/3","state":"OPEN","isDraft":false}]
JSON
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
      const result = await plugin.gather(
        'session-start',
        {
          repos: ['acme/ext'],
          ignoreAuthors: [],
          commentLimit: 10,
          triggers: { 'session-start': 'detailed' },
          onlyWhenNew: true,
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
      assert.match(result.text, /#2 Valid issue/);
      assert.match(result.text, /#3 Null author PR/);
    },
  );
});

test('github-watcher focuses reporting to current session repo by default', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "issue list" ]]; then
  repo=''
  prev=''
  for arg in "$@"; do
    if [[ "$prev" == "-R" ]]; then
      repo="$arg"
      break
    fi
    prev="$arg"
  done
  case "$repo" in
    acme/ext)
      cat <<'JSON'
[{"number":1,"title":"Ext issue","author":{"login":"alice"},"createdAt":"2026-03-30T10:00:00Z","url":"https://github.com/acme/ext/issues/1","state":"OPEN"}]
JSON
      ;;
    acme/other)
      cat <<'JSON'
[{"number":2,"title":"Other issue","author":{"login":"bob"},"createdAt":"2026-03-30T10:05:00Z","url":"https://github.com/acme/other/issues/2","state":"OPEN"}]
JSON
      ;;
    *)
      echo '[]'
      ;;
  esac
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
      const result = await plugin.gather(
        'interval:15m',
        {
          repos: ['acme/ext', 'acme/other'],
          ignoreAuthors: [],
          commentLimit: 10,
          onlyWhenNew: true,
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
            'acme/other': {
              lastIssueId: 0,
              lastPrId: 0,
              lastIssueAt: '2026-03-01T00:00:00.000Z',
              lastPrAt: '2026-03-01T00:00:00.000Z',
              lastCommentAt: '2026-03-01T00:00:00.000Z',
            },
          },
          lastCheck: '2026-03-01T00:00:00.000Z',
        },
        { ...testContext(), sessionRepo: 'acme/ext' },
      );

      assert.ok(result);
      assert.match(result.text, /acme\/ext:/);
      assert.doesNotMatch(result.text, /acme\/other:/);
    },
  );
});

test('github-watcher can disable session-repo focus', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "issue list" ]]; then
  repo=''
  prev=''
  for arg in "$@"; do
    if [[ "$prev" == "-R" ]]; then
      repo="$arg"
      break
    fi
    prev="$arg"
  done
  case "$repo" in
    acme/ext)
      cat <<'JSON'
[{"number":1,"title":"Ext issue","author":{"login":"alice"},"createdAt":"2026-03-30T10:00:00Z","url":"https://github.com/acme/ext/issues/1","state":"OPEN"}]
JSON
      ;;
    acme/other)
      cat <<'JSON'
[{"number":2,"title":"Other issue","author":{"login":"bob"},"createdAt":"2026-03-30T10:05:00Z","url":"https://github.com/acme/other/issues/2","state":"OPEN"}]
JSON
      ;;
    *)
      echo '[]'
      ;;
  esac
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
      const result = await plugin.gather(
        'interval:15m',
        {
          repos: ['acme/ext', 'acme/other'],
          ignoreAuthors: [],
          commentLimit: 10,
          onlyWhenNew: true,
          focusCurrentRepo: false,
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
            'acme/other': {
              lastIssueId: 0,
              lastPrId: 0,
              lastIssueAt: '2026-03-01T00:00:00.000Z',
              lastPrAt: '2026-03-01T00:00:00.000Z',
              lastCommentAt: '2026-03-01T00:00:00.000Z',
            },
          },
          lastCheck: '2026-03-01T00:00:00.000Z',
        },
        { ...testContext(), sessionRepo: 'acme/ext' },
      );

      assert.ok(result);
      assert.match(result.text, /acme\/ext:/);
      assert.match(result.text, /acme\/other:/);
    },
  );
});
