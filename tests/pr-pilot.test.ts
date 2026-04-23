import assert from 'node:assert/strict';
import test from 'node:test';

import { pluginUrl, testContext, withFakeCommand } from './helpers.ts';

test('pr-pilot auto-discovery excludes self-owned and controlled org repos by default', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "api user" ]]; then
  echo 'alice'
  exit 0
fi
if [[ "$1 $2" == "search prs" ]]; then
  cat <<'JSON'
[{"number":1,"title":"Self repo PR","repository":{"nameWithOwner":"alice/my-repo"},"url":"https://github.com/alice/my-repo/pull/1","updatedAt":"2026-03-31T08:00:00.000Z"},{"number":2,"title":"Controlled org repo PR","repository":{"nameWithOwner":"acme/internal"},"url":"https://github.com/acme/internal/pull/2","updatedAt":"2026-03-31T08:00:00.000Z"},{"number":3,"title":"External repo PR","repository":{"nameWithOwner":"external/public"},"url":"https://github.com/external/public/pull/3","updatedAt":"2026-03-31T08:00:00.000Z"}]
JSON
  exit 0
fi
if [[ "$1 $2" == "repo view" ]]; then
  if [[ "\${3:-}" == "acme/internal" ]]; then
    echo 'WRITE'
    exit 0
  fi
  if [[ "\${3:-}" == "external/public" ]]; then
    echo 'READ'
    exit 0
  fi
  echo 'READ'
  exit 0
fi
if [[ "$1 $2" == "api graphql" ]]; then
  owner='external'
  repo='public'
  number='3'
  for arg in "$@"; do
    case "$arg" in
      owner=*) owner="\${arg#owner=}" ;;
      repo=*) repo="\${arg#repo=}" ;;
      number=*) number="\${arg#number=}" ;;
    esac
  done
  cat <<JSON
{"data":{"repository":{"pullRequest":{"title":"PR \${owner}/\${repo}#\${number}","headRefName":"feature-branch","url":"https://github.com/\${owner}/\${repo}/pull/\${number}","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-03-31T09:00:00.000Z","labels":{"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS","contexts":{"nodes":[]}}}}]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}
JSON
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
    async () => {
      const plugin = (await import(pluginUrl('pr-pilot/src/index.ts'))).default;
      const result = await plugin.gather(
        'session-start',
        {
          autoDiscover: true,
          includeOwnRepos: false,
          includeControlledOrgRepos: false,
          repos: [],
          username: '',
          staleDays: 7,
          staleTtlDays: 30,
          dormantBackoffCycles: 12,
          triggers: { 'session-start': 'dashboard' },
          autonomy: {},
        },
        null,
        testContext(),
      );

      assert.ok(result);
      const trackedKeys = Object.keys(result.state.prs);
      assert.deepEqual(trackedKeys, ['external/public#3']);
    },
  );
});

test('pr-pilot emits merged/closed event for auto-discovered PRs dropped from discovery', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "search prs" ]]; then
  echo '[]'
  exit 0
fi
if [[ "$1 $2" == "api graphql" ]]; then
  cat <<'JSON'
{"data":{"repository":{"pullRequest":{"title":"PR upstream/project#7","headRefName":"feature-branch","url":"https://github.com/upstream/project/pull/7","state":"MERGED","mergeable":"MERGEABLE","updatedAt":"2026-03-31T09:00:00.000Z","labels":{"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS","contexts":{"nodes":[]}}}}]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}
JSON
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
    async () => {
      const plugin = (await import(pluginUrl('pr-pilot/src/index.ts'))).default;
      const result = await plugin.gather(
        'interval:5m',
        {
          autoDiscover: true,
          includeOwnRepos: false,
          includeControlledOrgRepos: false,
          repos: [],
          username: '',
          staleDays: 7,
          staleTtlDays: 30,
          dormantBackoffCycles: 12,
          triggers: { 'interval:5m': 'events' },
          autonomy: {},
        },
        {
          prs: {
            'upstream/project#7': {
              url: 'https://github.com/upstream/project/pull/7',
              repo: 'upstream/project',
              number: 7,
              title: 'Existing PR',
              branch: 'feature-branch',
              checks: { conclusion: 'success', failed: [], updatedAt: '2026-03-30T00:00:00.000Z' },
              reviews: { byReviewer: {}, pendingComments: [] },
              mergeable: true,
              labels: [],
              lastActivityAt: '2026-03-30T00:00:00.000Z',
              trackedAt: '2026-03-01T00:00:00.000Z',
              status: 'open',
              dormant: false,
              source: 'auto',
            },
          },
          cycle: 0,
          lastDiscovery: '2026-01-01T00:00:00.000Z',
          resolvedUsername: 'alice',
        },
        testContext(),
      );

      assert.ok(result);
      assert.match(result.text, /Merged:/);
    },
  );
});

test('pr-pilot claim key does not suppress distinct checks_failed events for same PR', async () => {
  const seen = new Set<string>();
  const claims = {
    tryClaim: async (key: string) => {
      if (seen.has(key)) return { claimed: false };
      seen.add(key);
      return { claimed: true };
    },
  };

  const baseConfig = {
    autoDiscover: false,
    includeOwnRepos: false,
    includeControlledOrgRepos: false,
    repos: [],
    username: '',
    staleDays: 7,
    staleTtlDays: 30,
    dormantBackoffCycles: 12,
    triggers: { 'interval:5m': 'events' },
    autonomy: { checksFailure: 'act' as const },
  };

  const prevState = {
    prs: {
      'upstream/project#9': {
        url: 'https://github.com/upstream/project/pull/9',
        repo: 'upstream/project',
        number: 9,
        title: 'Failure flaps',
        branch: 'feature-branch',
        checks: { conclusion: 'success', failed: [], updatedAt: '2026-03-30T00:00:00.000Z' },
        reviews: { byReviewer: {}, pendingComments: [] },
        mergeable: true,
        labels: [],
        lastActivityAt: '2026-03-30T00:00:00.000Z',
        trackedAt: '2026-03-01T00:00:00.000Z',
        status: 'open' as const,
        dormant: false,
        source: 'manual' as const,
      },
    },
    cycle: 0,
    lastDiscovery: '',
    resolvedUsername: 'alice',
  };

  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "api graphql" ]]; then
  cat <<'JSON'
{"data":{"repository":{"pullRequest":{"title":"PR upstream/project#9","headRefName":"feature-branch","url":"https://github.com/upstream/project/pull/9","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-03-31T09:00:00.000Z","labels":{"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE","contexts":{"nodes":[{"__typename":"CheckRun","name":"lint","conclusion":"FAILURE","title":"lint failed"}]}}}}]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}
JSON
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
    async () => {
      const plugin = (await import(pluginUrl('pr-pilot/src/index.ts'))).default;
      const result = await plugin.gather(
        'interval:5m',
        baseConfig,
        prevState,
        { ...testContext(), claims },
      );
      assert.ok(result);
      assert.match(result.text, /Action required/);
      assert.doesNotMatch(result.text, /being handled by another session/);
    },
  );

  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "api graphql" ]]; then
  cat <<'JSON'
{"data":{"repository":{"pullRequest":{"title":"PR upstream/project#9","headRefName":"feature-branch","url":"https://github.com/upstream/project/pull/9","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-04-01T09:00:00.000Z","labels":{"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"FAILURE","contexts":{"nodes":[{"__typename":"CheckRun","name":"tests","conclusion":"FAILURE","title":"tests failed"}]}}}}]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}
JSON
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
    async () => {
      const plugin = (await import(pluginUrl('pr-pilot/src/index.ts'))).default;
      const result = await plugin.gather(
        'interval:5m',
        baseConfig,
        prevState,
        { ...testContext(), claims },
      );
      assert.ok(result);
      assert.match(result.text, /Action required/);
      assert.doesNotMatch(result.text, /being handled by another session/);
    },
  );
});

// ── Regression: tracked PRs survive MCP reconnect (#1) ──────────────

test('pr-pilot: manual PRs survive session-start when discovery returns empty', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "search prs" ]]; then
  echo '[]'
  exit 0
fi
if [[ "$1 $2" == "api graphql" ]]; then
  cat <<'JSON'
{"data":{"repository":{"pullRequest":{"title":"Tracked PR","headRefName":"feat","url":"https://github.com/upstream/project/pull/99","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-04-01T09:00:00.000Z","labels":{"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS","contexts":{"nodes":[]}}}}]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}
JSON
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
    async () => {
      const plugin = (await import(pluginUrl('pr-pilot/src/index.ts'))).default;
      const result = await plugin.gather(
        'session-start',
        {
          autoDiscover: true,
          includeOwnRepos: false,
          includeControlledOrgRepos: false,
          repos: [],
          username: '',
          staleDays: 7,
          staleTtlDays: 30,
          dormantBackoffCycles: 12,
          triggers: { 'session-start': 'dashboard' },
          autonomy: {},
        },
        {
          prs: {
            'upstream/project#99': {
              url: 'https://github.com/upstream/project/pull/99',
              repo: 'upstream/project',
              number: 99,
              title: 'Tracked PR',
              branch: 'feat',
              checks: { conclusion: 'success', failed: [], updatedAt: '2026-03-30T00:00:00.000Z' },
              reviews: { byReviewer: {}, pendingComments: [] },
              mergeable: true,
              labels: [],
              lastActivityAt: '2026-03-30T00:00:00.000Z',
              trackedAt: '2026-03-01T00:00:00.000Z',
              status: 'open',
              dormant: false,
              source: 'manual',
            },
          },
          cycle: 100,
          lastDiscovery: '2026-03-31T10:00:00.000Z',
          resolvedUsername: 'alice',
        },
        testContext(),
      );

      assert.ok(result, 'gather should return a result');
      assert.ok(result.state.prs['upstream/project#99'], 'manual PR must survive session-start');
      assert.equal(result.state.prs['upstream/project#99'].source, 'manual');
    },
  );
});

test('pr-pilot: auto PRs survive session-start when fetchPRData fails during cleanup', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "search prs" ]]; then
  echo '[]'
  exit 0
fi
if [[ "$1 $2" == "api graphql" ]]; then
  echo '{"errors":[{"message":"not found"}]}' >&2
  exit 1
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
    async () => {
      const plugin = (await import(pluginUrl('pr-pilot/src/index.ts'))).default;
      const result = await plugin.gather(
        'session-start',
        {
          autoDiscover: true,
          includeOwnRepos: false,
          includeControlledOrgRepos: false,
          repos: [],
          username: '',
          staleDays: 7,
          staleTtlDays: 30,
          dormantBackoffCycles: 12,
          triggers: { 'session-start': 'dashboard' },
          autonomy: {},
        },
        {
          prs: {
            'upstream/project#88': {
              url: 'https://github.com/upstream/project/pull/88',
              repo: 'upstream/project',
              number: 88,
              title: 'Auto-tracked PR',
              branch: 'feat',
              checks: { conclusion: 'success', failed: [], updatedAt: '2026-03-30T00:00:00.000Z' },
              reviews: { byReviewer: {}, pendingComments: [] },
              mergeable: true,
              labels: [],
              lastActivityAt: '2026-03-30T00:00:00.000Z',
              trackedAt: '2026-03-01T00:00:00.000Z',
              status: 'open',
              dormant: false,
              source: 'auto',
            },
          },
          cycle: 50,
          lastDiscovery: '2026-03-31T10:00:00.000Z',
          resolvedUsername: 'alice',
        },
        testContext(),
      );

      assert.ok(result, 'gather should return a result');
      assert.ok(result.state.prs['upstream/project#88'], 'auto PR must survive when fetchPRData fails');
    },
  );
});

