import assert from 'node:assert/strict';
import test from 'node:test';

import { pluginUrl, testContext, withFakeCommand } from './helpers.ts';

test('pr-pilot emits now_mergeable after transient unknown mergeability', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "api graphql" ]]; then
  cat <<'JSON'
{"data":{"repository":{"pullRequest":{"title":"PR upstream/project#42","headRefName":"feature-branch","url":"https://github.com/upstream/project/pull/42","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-03-31T09:00:00.000Z","labels":{"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS","contexts":{"nodes":[]}}}}]},"reviews":{"nodes":[]},"reviewThreads":{"nodes":[]}}}}}
JSON
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
    async () => {
      const plugin = (await import(pluginUrl('pr-pilot/src/index.ts'))).default;
      const checkTool = plugin.mcp.tools.find((tool: { name: string }) => tool.name === 'check');
      assert.ok(checkTool);

      const key = 'upstream/project#42';
      const result = await checkTool.handler(
        { pr: key },
        { staleDays: 7, staleTtlDays: 30, autonomy: {} },
        new AbortController().signal,
        {
          prs: {
            [key]: {
              url: 'https://github.com/upstream/project/pull/42',
              repo: 'upstream/project',
              number: 42,
              title: 'Fix conflict handling',
              branch: 'feature-branch',
              checks: { conclusion: 'success', failed: [], updatedAt: '2026-03-30T00:00:00.000Z' },
              reviews: { byReviewer: {}, pendingComments: [] },
              mergeable: null,
              hadConflict: true,
              labels: [],
              lastActivityAt: '2026-03-30T00:00:00.000Z',
              trackedAt: '2026-03-01T00:00:00.000Z',
              status: 'open',
              dormant: false,
              source: 'manual',
            },
          },
          cycle: 0,
          lastDiscovery: '',
          resolvedUsername: 'alice',
        },
      );

      assert.ok(result);
      assert.match(result.text, /Now mergeable/);
      assert.equal(result.state.prs[key].hadConflict, false);
    },
  );
});

test('pr-pilot keeps latest review state per reviewer when API order is mixed', async () => {
  await withFakeCommand(
    'gh',
    `
if [[ "$1 $2" == "api graphql" ]]; then
  cat <<'JSON'
{"data":{"repository":{"pullRequest":{"title":"PR upstream/project#43","headRefName":"feature-branch","url":"https://github.com/upstream/project/pull/43","state":"OPEN","mergeable":"MERGEABLE","updatedAt":"2026-03-31T09:00:00.000Z","labels":{"nodes":[]},"commits":{"nodes":[{"commit":{"statusCheckRollup":{"state":"SUCCESS","contexts":{"nodes":[]}}}}]},"reviews":{"nodes":[{"author":{"login":"reviewer1"},"state":"APPROVED","submittedAt":"2026-03-31T08:00:00.000Z"},{"author":{"login":"reviewer1"},"state":"COMMENTED","submittedAt":"2026-03-30T08:00:00.000Z"}]},"reviewThreads":{"nodes":[]}}}}}
JSON
  exit 0
fi
echo "unexpected gh args: $*" >&2
exit 1
`,
    async () => {
      const plugin = (await import(pluginUrl('pr-pilot/src/index.ts'))).default;
      const checkTool = plugin.mcp.tools.find((tool: { name: string }) => tool.name === 'check');
      assert.ok(checkTool);

      const key = 'upstream/project#43';
      const result = await checkTool.handler(
        { pr: key },
        { staleDays: 7, staleTtlDays: 30, autonomy: {} },
        new AbortController().signal,
        {
          prs: {
            [key]: {
              url: 'https://github.com/upstream/project/pull/43',
              repo: 'upstream/project',
              number: 43,
              title: 'Review ordering',
              branch: 'feature-branch',
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
          cycle: 0,
          lastDiscovery: '',
          resolvedUsername: 'alice',
        },
      );

      assert.ok(result);
      assert.equal(result.state.prs[key].reviews.byReviewer.reviewer1?.state, 'APPROVED');
      assert.equal(result.state.prs[key].reviews.byReviewer.reviewer1?.updatedAt, '2026-03-31T08:00:00.000Z');
    },
  );
});

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
