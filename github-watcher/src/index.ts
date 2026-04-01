/**
 * github-watcher — agent-awareness provider plugin
 *
 * Monitors GitHub repos for new issues, PRs, and comments from external users.
 * Uses `gh` CLI for auth-free access. State-tracked: only reports deltas.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AwarenessPlugin,
  GatherContext,
  GatherResult,
  PluginConfig,
  Trigger,
} from 'agent-awareness';

const exec = promisify(execFile);

// ── Types ──────────────────────────────────────────────────────────────────

interface RepoState {
  lastIssueId: number;
  lastPrId: number;
  /** ISO timestamp of last seen comment across all issues/PRs */
  lastCommentAt: string;
  /** ISO timestamp of last seen issue event */
  lastIssueAt: string;
  /** ISO timestamp of last seen PR event */
  lastPrAt: string;
}

interface WatcherState extends Record<string, unknown> {
  repos: Record<string, RepoState>;
  lastCheck: string;
}

interface GHItem {
  number: number;
  title: string;
  author: { login: string };
  createdAt: string;
  url: string;
  state?: string;
  isDraft?: boolean;
}

interface GHComment {
  author: { login: string };
  body: string;
  createdAt: string;
  url: string;
  // Added by our processing
  issueNumber?: number;
  issueTitle?: string;
}

interface RepoActivity {
  repo: string;
  newIssues: GHItem[];
  newPRs: GHItem[];
  newComments: GHComment[];
}

type Log = NonNullable<GatherContext['log']>;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLog(ctx?: { log?: Log }): Log {
  return ctx?.log ?? { warn: console.error, error: console.error };
}

async function gh(args: string[], log: Log, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, {
      timeout: 15_000,
      signal,
      env: { ...process.env, GH_PAGER: '' },
    });
    return stdout.trim();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('ABORT_ERR') || msg.includes('aborted')) throw err;
    log.warn(`gh ${args[0]} failed: ${msg}`);
    return '';
  }
}

async function fetchNewIssues(
  repo: string,
  since: string,
  ignoreAuthors: Set<string>,
  limit: number,
  log: Log,
  signal?: AbortSignal,
): Promise<GHItem[]> {
  const json = await gh([
    'issue', 'list',
    '-R', repo,
    '--json', 'number,title,author,createdAt,url,state',
    '--limit', String(limit),
    '-s', 'all',
  ], log, signal);
  if (!json) return [];
  try {
    const items: Array<Partial<GHItem> & { author?: { login?: string } | null }> = JSON.parse(json);
    return items
      .flatMap((i): GHItem[] => {
        if (
          typeof i.number !== 'number'
          || typeof i.title !== 'string'
          || typeof i.createdAt !== 'string'
          || typeof i.url !== 'string'
        ) {
          return [];
        }
        return [{
          number: i.number,
          title: i.title,
          author: { login: i.author?.login ?? 'unknown' },
          createdAt: i.createdAt,
          url: i.url,
          state: i.state,
          isDraft: i.isDraft,
        }];
      })
      .filter(
        (i) => !ignoreAuthors.has(i.author.login.toLowerCase())
          && i.createdAt > since,
      );
  } catch { return []; }
}

async function fetchNewPRs(
  repo: string,
  since: string,
  ignoreAuthors: Set<string>,
  limit: number,
  log: Log,
  signal?: AbortSignal,
): Promise<GHItem[]> {
  const json = await gh([
    'pr', 'list',
    '-R', repo,
    '--json', 'number,title,author,createdAt,url,state,isDraft',
    '--limit', String(limit),
    '-s', 'all',
  ], log, signal);
  if (!json) return [];
  try {
    const items: Array<Partial<GHItem> & { author?: { login?: string } | null }> = JSON.parse(json);
    return items
      .flatMap((i): GHItem[] => {
        if (
          typeof i.number !== 'number'
          || typeof i.title !== 'string'
          || typeof i.createdAt !== 'string'
          || typeof i.url !== 'string'
        ) {
          return [];
        }
        return [{
          number: i.number,
          title: i.title,
          author: { login: i.author?.login ?? 'unknown' },
          createdAt: i.createdAt,
          url: i.url,
          state: i.state,
          isDraft: i.isDraft,
        }];
      })
      .filter(
        (i) => !ignoreAuthors.has(i.author.login.toLowerCase())
          && i.createdAt > since,
      );
  } catch { return []; }
}

async function fetchRecentComments(
  repo: string,
  since: string,
  ignoreAuthors: Set<string>,
  limit: number,
  log: Log,
  signal?: AbortSignal,
): Promise<GHComment[]> {
  // Use GraphQL for efficient comment fetching across all issues/PRs
  const query = `
    query($repo: String!, $owner: String!) {
      repository(owner: $owner, name: $repo) {
        issueComments: issues(last: 10, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            number
            title
            comments(last: 5) {
              nodes {
                author { login }
                body
                createdAt
                url
              }
            }
          }
        }
        prComments: pullRequests(last: 10, orderBy: {field: UPDATED_AT, direction: DESC}) {
          nodes {
            number
            title
            comments(last: 5) {
              nodes {
                author { login }
                body
                createdAt
                url
              }
            }
          }
        }
      }
    }
  `;

  const [owner, name] = repo.split('/');
  if (!owner || !name) return [];

  const json = await gh([
    'api', 'graphql',
    '-f', `query=${query}`,
    '-f', `owner=${owner}`,
    '-f', `repo=${name}`,
  ], log, signal);

  if (!json) return [];

  try {
    const data = JSON.parse(json);
    const comments: GHComment[] = [];
    const repoData = data.data?.repository;
    if (!repoData) return [];

    for (const source of ['issueComments', 'prComments'] as const) {
      for (const item of repoData[source]?.nodes ?? []) {
        for (const comment of item.comments?.nodes ?? []) {
          const authorLogin = comment.author?.login?.toLowerCase() ?? 'unknown';
          if (
            !ignoreAuthors.has(authorLogin)
            && comment.createdAt > since
          ) {
            comments.push({
              author: { login: comment.author?.login ?? 'unknown' },
              body: comment.body,
              createdAt: comment.createdAt,
              url: comment.url,
              issueNumber: item.number,
              issueTitle: item.title,
            });
          }
        }
      }
    }

    return comments
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  } catch { return []; }
}

async function fetchRepoActivity(
  repo: string,
  repoState: RepoState,
  ignoreAuthors: Set<string>,
  issueLimit: number,
  prLimit: number,
  commentLimit: number,
  log: Log,
  signal?: AbortSignal,
): Promise<RepoActivity> {
  const [newIssues, newPRs, newComments] = await Promise.all([
    fetchNewIssues(repo, repoState.lastIssueAt, ignoreAuthors, issueLimit, log, signal),
    fetchNewPRs(repo, repoState.lastPrAt, ignoreAuthors, prLimit, log, signal),
    fetchRecentComments(repo, repoState.lastCommentAt, ignoreAuthors, commentLimit, log, signal),
  ]);

  return { repo, newIssues, newPRs, newComments };
}

function defaultRepoState(): RepoState {
  const now = new Date().toISOString();
  return {
    lastIssueId: 0,
    lastPrId: 0,
    lastCommentAt: now,
    lastIssueAt: now,
    lastPrAt: now,
  };
}

function updateRepoState(prev: RepoState, activity: RepoActivity): RepoState {
  const state = { ...prev };

  if (activity.newIssues.length > 0) {
    const latest = activity.newIssues.reduce(
      (max, i) => (i.createdAt > max ? i.createdAt : max),
      state.lastIssueAt,
    );
    state.lastIssueAt = latest;
    state.lastIssueId = Math.max(state.lastIssueId, ...activity.newIssues.map((i) => i.number));
  }

  if (activity.newPRs.length > 0) {
    const latest = activity.newPRs.reduce(
      (max, i) => (i.createdAt > max ? i.createdAt : max),
      state.lastPrAt,
    );
    state.lastPrAt = latest;
    state.lastPrId = Math.max(state.lastPrId, ...activity.newPRs.map((i) => i.number));
  }

  if (activity.newComments.length > 0) {
    const latest = activity.newComments.reduce(
      (max, c) => (c.createdAt > max ? c.createdAt : max),
      state.lastCommentAt,
    );
    state.lastCommentAt = latest;
  }

  return state;
}

function buildActivityClaimKey(activity: RepoActivity): string {
  const issues = activity.newIssues
    .map((i) => `i${i.number}@${i.createdAt}`)
    .sort();
  const prs = activity.newPRs
    .map((p) => `p${p.number}@${p.createdAt}`)
    .sort();
  const comments = activity.newComments
    .map((c) => `c${c.url}@${c.createdAt}`)
    .sort();
  return `${activity.repo}:activity:${[...issues, ...prs, ...comments].join('|')}`;
}

// ── Formatters ─────────────────────────────────────────────────────────────

function formatCompact(activities: RepoActivity[]): string {
  const parts: string[] = [];

  for (const a of activities) {
    const counts: string[] = [];
    if (a.newIssues.length) counts.push(`${a.newIssues.length} new issue${a.newIssues.length > 1 ? 's' : ''}`);
    if (a.newPRs.length) counts.push(`${a.newPRs.length} new PR${a.newPRs.length > 1 ? 's' : ''}`);
    if (a.newComments.length) counts.push(`${a.newComments.length} new comment${a.newComments.length > 1 ? 's' : ''}`);
    if (counts.length > 0) {
      parts.push(`${a.repo}: ${counts.join(', ')}`);
    }
  }

  return parts.length > 0
    ? `GitHub: ${parts.join(' | ')}`
    : '';
}

function formatDetailed(activities: RepoActivity[]): string {
  const sections: string[] = [];

  for (const a of activities) {
    const hasActivity = a.newIssues.length || a.newPRs.length || a.newComments.length;
    if (!hasActivity) continue;

    const lines: string[] = [`**${a.repo}**`];

    for (const issue of a.newIssues) {
      lines.push(`  📋 #${issue.number} ${issue.title} (by @${issue.author.login})`);
    }

    for (const pr of a.newPRs) {
      const draft = pr.isDraft ? ' [draft]' : '';
      lines.push(`  🔀 #${pr.number} ${pr.title} (by @${pr.author.login})${draft}`);
    }

    for (const comment of a.newComments) {
      const preview = comment.body.slice(0, 80).replace(/\n/g, ' ');
      lines.push(`  💬 #${comment.issueNumber} @${comment.author.login}: ${preview}${comment.body.length > 80 ? '…' : ''}`);
    }

    sections.push(lines.join('\n'));
  }

  return sections.length > 0
    ? `GitHub activity:\n${sections.join('\n')}`
    : '';
}

// ── Plugin ─────────────────────────────────────────────────────────────────

export default {
  name: 'github-watcher',
  description: 'Monitors GitHub repos for new issues, PRs, and comments from external users',

  triggers: ['session-start', 'interval:15m'],

  defaults: {
    enabled: true,
    /** GitHub repos to watch — array of 'owner/repo' strings */
    repos: [],
    /** GitHub usernames to ignore (e.g. your own, bots) */
    ignoreAuthors: [] as string[],
    /** Max comments to fetch per repo per check */
    commentLimit: 10,
    /** Max issues to fetch per repo per check */
    issueLimit: 50,
    /** Max PRs to fetch per repo per check */
    prLimit: 50,
    /** Output format: 'compact' for interval, 'detailed' for session-start */
    format: 'auto',
    /** Only inject when there's new activity (true = silent when nothing new) */
    onlyWhenNew: true,
    triggers: {
      'session-start': 'detailed',
      'interval:15m': 'compact',
    },
  },

  async gather(
    trigger: Trigger,
    config: PluginConfig,
    prevState: WatcherState | null,
    context: GatherContext,
  ): Promise<GatherResult<WatcherState> | null> {
    const repos = config.repos as string[];
    if (!repos || repos.length === 0) return null;

    const log = makeLog(context);
    const signal = context.signal;
    const ignoreAuthors = new Set(
      ((config.ignoreAuthors as string[]) ?? []).map((u) => u.toLowerCase()),
    );
    const commentLimit = (config.commentLimit as number) ?? 10;
    const issueLimit = (config.issueLimit as number) ?? 50;
    const prLimit = (config.prLimit as number) ?? 50;
    const onlyWhenNew = config.onlyWhenNew !== false;

    // Restore state
    const state: WatcherState = prevState ?? {
      repos: {},
      lastCheck: new Date().toISOString(),
    };

    // Initialize state for new repos
    for (const repo of repos) {
      if (!state.repos[repo]) {
        state.repos[repo] = defaultRepoState();
      }
    }

    // Fetch activity for all repos in parallel
    const activities = await Promise.all(
      repos.map((repo) =>
        fetchRepoActivity(repo, state.repos[repo]!, ignoreAuthors, issueLimit, prLimit, commentLimit, log, signal)
          .catch((): RepoActivity => ({ repo, newIssues: [], newPRs: [], newComments: [] })),
      ),
    );

    // Update state with what we've seen
    const newState: WatcherState = {
      repos: { ...state.repos },
      lastCheck: new Date().toISOString(),
    };
    for (const activity of activities) {
      newState.repos[activity.repo] = updateRepoState(
        state.repos[activity.repo]!,
        activity,
      );
    }

    // Claim repo activity to prevent duplicate action across concurrent sessions
    if (context.claims) {
      const claimedActivities: RepoActivity[] = [];
      for (const activity of activities) {
        const hasActivity = activity.newIssues.length || activity.newPRs.length || activity.newComments.length;
        if (!hasActivity) { claimedActivities.push(activity); continue; }

        const claimKey = buildActivityClaimKey(activity);
        const { claimed } = await context.claims.tryClaim(claimKey, 20);
        if (claimed) {
          claimedActivities.push(activity);
        }
        // Unclaimed repos are silently dropped — another session reports them
      }
      activities.length = 0;
      activities.push(...claimedActivities);
    }

    // Determine format
    const triggerFormat = config.triggers?.[trigger as string];
    const format = typeof triggerFormat === 'string'
      ? triggerFormat
      : (config.format as string) ?? 'auto';

    const useDetailed = format === 'detailed'
      || (format === 'auto' && trigger === 'session-start');

    const text = useDetailed
      ? formatDetailed(activities)
      : formatCompact(activities);

    // If onlyWhenNew and nothing to report, still update state silently
    if (onlyWhenNew && !text) {
      return { text: '', state: newState };
    }

    return {
      text: text || 'GitHub: no new external activity',
      state: newState,
    };
  },

  mcp: {
    tools: [
      {
        name: 'check',
        description: 'Check GitHub repos for new activity right now. Returns detailed output regardless of interval.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            repo: {
              type: 'string',
              description: 'Specific repo to check (owner/repo). Omit to check all watched repos.',
            },
            since: {
              type: 'string',
              description: 'ISO timestamp to check from. Omit to use last known state.',
            },
          },
        },
        async handler(
          params: Record<string, unknown>,
          config: PluginConfig,
          signal: AbortSignal,
          prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const allRepos = config.repos as string[];
          const repos = params.repo ? [params.repo as string] : allRepos;
          if (!repos.length) return { text: 'No repos configured' };

          const log = makeLog();
          const ignoreAuthors = new Set(
            ((config.ignoreAuthors as string[]) ?? []).map((u) => u.toLowerCase()),
          );
          const commentLimit = (config.commentLimit as number) ?? 10;
          const issueLimit = (config.issueLimit as number) ?? 50;
          const prLimit = (config.prLimit as number) ?? 50;

          const state = (prevState as WatcherState | null) ?? {
            repos: {},
            lastCheck: new Date().toISOString(),
          };

          // If specific since was given, create temp state with that timestamp
          const checkState: WatcherState = {
            ...state,
            repos: { ...state.repos },
          };
          if (params.since) {
            for (const repo of repos) {
              checkState.repos[repo] = {
                lastIssueId: 0,
                lastPrId: 0,
                lastCommentAt: params.since as string,
                lastIssueAt: params.since as string,
                lastPrAt: params.since as string,
              };
            }
          }

          for (const repo of repos) {
            if (!checkState.repos[repo]) {
              checkState.repos[repo] = defaultRepoState();
            }
          }

          const activities = await Promise.all(
            repos.map((repo) =>
              fetchRepoActivity(repo, checkState.repos[repo]!, ignoreAuthors, issueLimit, prLimit, commentLimit, log, signal)
                .catch((): RepoActivity => ({ repo, newIssues: [], newPRs: [], newComments: [] })),
            ),
          );

          // Update state
          const newState: WatcherState = {
            repos: { ...state.repos },
            lastCheck: new Date().toISOString(),
          };
          for (const activity of activities) {
            newState.repos[activity.repo] = updateRepoState(
              state.repos[activity.repo] ?? defaultRepoState(),
              activity,
            );
          }

          const text = formatDetailed(activities) || 'No new external activity';
          return { text, state: newState };
        },
      },
      {
        name: 'repos',
        description: 'List currently watched repos and their last-check timestamps',
        inputSchema: { type: 'object' as const },
        async handler(
          _params: Record<string, unknown>,
          config: PluginConfig,
          _signal: AbortSignal,
          prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const repos = config.repos as string[];
          if (!repos.length) return { text: 'No repos configured' };

          const state = (prevState as WatcherState | null) ?? { repos: {}, lastCheck: 'never' };
          const lines = repos.map((repo) => {
            const rs = state.repos[repo];
            return rs
              ? `${repo} — last checked: ${state.lastCheck}`
              : `${repo} — not yet checked`;
          });

          return { text: `Watched repos:\n${lines.join('\n')}` };
        },
      },
    ],
  },
} satisfies AwarenessPlugin<WatcherState>;
