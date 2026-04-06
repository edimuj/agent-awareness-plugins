/**
 * actions-watcher — agent-awareness plugin for GitHub Actions monitoring.
 *
 * Tracks workflow run status for configured repos (including private).
 * Reports failures and recoveries — silent when everything is green.
 * Uses `gh` CLI for auth and API access.
 *
 * Auto-discovery: set `owner` to automatically find repos with active workflows.
 * Stale filtering: `maxAgeDays` ignores workflows with no runs in the last N days.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AwarenessPlugin,
  GatherContext,
  PluginConfig,
  Trigger,
} from 'agent-awareness';

const exec = promisify(execFile);

// --- Types ---

interface WorkflowRun {
  databaseId: number;
  workflowName: string;
  name: string;       // run name (may differ from workflow name)
  status: string;     // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | skipped | null
  headBranch: string;
  event: string;      // push | schedule | workflow_dispatch | pull_request
  createdAt: string;
  updatedAt: string;
  url: string;
}

interface WorkflowStatus {
  workflowName: string;
  conclusion: string;  // last completed conclusion
  runId: number;
  branch: string;
  event: string;
  updatedAt: string;
  url: string;
}

interface RepoState {
  workflows: Record<string, WorkflowStatus>;
  lastCheckedRunId: number;
}

interface WatcherState extends Record<string, unknown> {
  repos: Record<string, RepoState>;
  discoveredRepos?: string[];
  discoveredAt?: string;
}

// --- gh CLI helpers ---

async function ghRunList(
  repo: string,
  limit: number,
  signal?: AbortSignal,
): Promise<WorkflowRun[]> {
  try {
    const { stdout } = await exec(
      'gh',
      [
        'run', 'list',
        '--repo', repo,
        '--limit', String(limit),
        '--json', 'databaseId,workflowName,name,status,conclusion,headBranch,event,createdAt,updatedAt,url',
      ],
      { signal },
    );
    return JSON.parse(stdout.trim() || '[]');
  } catch {
    return [];
  }
}

/**
 * Discover repos with workflow runs for a GitHub owner.
 * Lists all repos, checks each for any workflow runs (regardless of age).
 * Stale filtering is handled separately at reporting time via maxAgeDays.
 */
async function discoverRepos(
  owner: string,
  signal?: AbortSignal,
): Promise<string[]> {
  try {
    const { stdout } = await exec(
      'gh',
      ['repo', 'list', owner, '--limit', '200', '--json', 'nameWithOwner', '-q', '.[].nameWithOwner'],
      { signal },
    );
    const allRepos = stdout.trim().split('\n').filter(Boolean);
    if (allRepos.length === 0) return [];

    // Check each repo for any workflow runs in parallel
    const checks = await Promise.all(
      allRepos.map(async (repo) => {
        try {
          const runs = await ghRunList(repo, 1, signal);
          return runs.length > 0 ? repo : null;
        } catch {
          return null;
        }
      }),
    );

    return checks.filter((r): r is string => r !== null).sort();
  } catch {
    return [];
  }
}

// --- Core logic ---

function getLatestPerWorkflow(
  runs: WorkflowRun[],
  workflowFilter: string[],
  branchFilter: string[],
): Map<string, WorkflowRun> {
  const latest = new Map<string, WorkflowRun>();

  for (const run of runs) {
    if (run.status !== 'completed') continue;

    // Apply workflow name filter (empty = all)
    if (workflowFilter.length > 0) {
      const match = workflowFilter.some(f =>
        run.workflowName.toLowerCase().includes(f.toLowerCase()),
      );
      if (!match) continue;
    }

    // Apply branch filter (empty = all)
    if (branchFilter.length > 0 && !branchFilter.includes(run.headBranch)) continue;

    if (!latest.has(run.workflowName)) {
      latest.set(run.workflowName, run);
    }
  }

  return latest;
}

/** Remove workflow runs older than maxAgeDays. */
function filterStaleRuns(
  latestRuns: Map<string, WorkflowRun>,
  maxAgeDays: number,
): Map<string, WorkflowRun> {
  if (maxAgeDays <= 0) return latestRuns;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const filtered = new Map<string, WorkflowRun>();
  for (const [name, run] of latestRuns) {
    if (new Date(run.updatedAt).getTime() >= cutoff) {
      filtered.set(name, run);
    }
  }
  return filtered;
}

/** Merge explicit config repos with auto-discovered repos (deduped). */
function getEffectiveRepos(
  configRepos: string[],
  discoveredRepos: string[] | undefined,
): string[] {
  const set = new Set([...configRepos, ...(discoveredRepos ?? [])]);
  return [...set].sort();
}

function focusSessionRepo(
  repos: string[],
  config: PluginConfig,
  context: GatherContext,
): string[] {
  if (config.focusCurrentRepo === false) return repos;

  const sessionRepo = typeof context.sessionRepo === 'string'
    ? context.sessionRepo.trim().toLowerCase()
    : '';
  if (!sessionRepo) return repos;

  const matched = repos.find((repo) => repo.toLowerCase() === sessionRepo);
  return matched ? [matched] : repos;
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

type Autonomy = 'full' | 'report';

const DIRECTIVES: Record<string, string> = {
  failed: 'Action required: clone the repo, check the workflow logs (gh run view), identify the failure cause, fix it, push, and monitor until the run passes.',
  still_failing: 'Action required: previous fix attempt did not resolve this. Re-check workflow logs, investigate deeper, fix, push, and monitor until green.',
  recovered: 'No action needed — this was previously failing and has recovered.',
};

function detectChanges(
  repo: string,
  latestRuns: Map<string, WorkflowRun>,
  prevRepoState: RepoState | undefined,
  autonomy: Autonomy,
): { lines: string[]; newState: RepoState } {
  const lines: string[] = [];
  const workflows: Record<string, WorkflowStatus> = {};
  let maxRunId = prevRepoState?.lastCheckedRunId ?? 0;

  for (const [wfName, run] of latestRuns) {
    const prev = prevRepoState?.workflows[wfName];
    const conclusion = run.conclusion ?? 'unknown';

    workflows[wfName] = {
      workflowName: wfName,
      conclusion,
      runId: run.databaseId,
      branch: run.headBranch,
      event: run.event,
      updatedAt: run.updatedAt,
      url: run.url,
    };

    if (run.databaseId > maxRunId) maxRunId = run.databaseId;

    // Skip if we've seen this exact run before
    if (prev && prev.runId === run.databaseId) continue;

    // New run — check for state changes
    if (conclusion === 'failure') {
      const wasOk = !prev || prev.conclusion !== 'failure';
      const prefix = wasOk ? 'FAILED' : 'still failing';
      let line = `${prefix}: ${repo} / ${wfName} (${run.headBranch}, ${run.event}, ${timeAgo(run.updatedAt)})`;
      if (autonomy === 'full') line += `. ${wasOk ? DIRECTIVES.failed : DIRECTIVES.still_failing}`;
      lines.push(line);
    } else if (conclusion === 'success' && prev?.conclusion === 'failure') {
      let line = `RECOVERED: ${repo} / ${wfName} (${run.headBranch}, ${timeAgo(run.updatedAt)})`;
      if (autonomy === 'full') line += `. ${DIRECTIVES.recovered}`;
      lines.push(line);
    }
  }

  return {
    lines,
    newState: { workflows, lastCheckedRunId: maxRunId },
  };
}

function formatSessionStart(
  repo: string,
  latestRuns: Map<string, WorkflowRun>,
  autonomy: Autonomy,
): string[] {
  if (latestRuns.size === 0) return [];

  const lines: string[] = [];

  for (const [wfName, run] of latestRuns) {
    const conclusion = run.conclusion ?? 'unknown';
    if (conclusion === 'failure') {
      let line = `  ${wfName} (${run.headBranch}): FAILED — ${timeAgo(run.updatedAt)}`;
      if (autonomy === 'full') line += `. ${DIRECTIVES.failed}`;
      lines.push(line);
    }
    // Only failures reported — passing workflows are silent
  }

  if (lines.length === 0) return [];

  return [`${repo}: ${lines.length} failing workflows`, ...lines];
}

function buildRepoStateFromLatest(
  latestRuns: Map<string, WorkflowRun>,
  prevRepoState: RepoState | undefined,
): RepoState {
  const workflows: Record<string, WorkflowStatus> = {};
  let maxRunId = prevRepoState?.lastCheckedRunId ?? 0;

  for (const [wfName, run] of latestRuns) {
    workflows[wfName] = {
      workflowName: wfName,
      conclusion: run.conclusion ?? 'unknown',
      runId: run.databaseId,
      branch: run.headBranch,
      event: run.event,
      updatedAt: run.updatedAt,
      url: run.url,
    };
    if (run.databaseId > maxRunId) maxRunId = run.databaseId;
  }

  return { workflows, lastCheckedRunId: maxRunId };
}

// --- Plugin ---

export default {
  name: 'actions-watcher',
  description: 'Monitors GitHub Actions workflow runs — reports failures and recoveries',
  triggers: ['session-start', 'interval:5m'],

  defaults: {
    owner: '',
    repos: [],
    focusCurrentRepo: true,
    maxAgeDays: 14,
    autonomy: 'report',
    workflowFilter: [],
    branchFilter: [],
    limit: 10,
    triggers: {
      'session-start': 'full',
      'interval:5m': 'delta',
    },
  },

  async gather(
    trigger: Trigger,
    config: PluginConfig,
    prevState: WatcherState | null,
    context: GatherContext,
  ) {
    const configRepos = (config.repos as string[]) ?? [];
    const owner = (config.owner as string) || '';
    const maxAgeDays = (config.maxAgeDays as number) ?? 14;
    const autonomy = ((config.autonomy as string) || 'report') as Autonomy;
    const workflowFilter = (config.workflowFilter as string[]) ?? [];
    const branchFilter = (config.branchFilter as string[]) ?? [];
    const limit = (config.limit as number) ?? 10;
    const isSessionStart = trigger === 'session-start';

    // Auto-discover repos on session-start if owner is configured
    let discoveredRepos = prevState?.discoveredRepos as string[] | undefined;
    let discoveredAt = prevState?.discoveredAt as string | undefined;

    if (owner && isSessionStart) {
      discoveredRepos = await discoverRepos(owner, context.signal);
      discoveredAt = new Date().toISOString();
      context.log?.warn?.(`actions-watcher: discovered ${discoveredRepos.length} repos with active workflows for ${owner}`);
    }

    // Merge configured + discovered repos
    const allRepos = getEffectiveRepos(configRepos, discoveredRepos);
    if (allRepos.length === 0) return null;
    const repos = focusSessionRepo(allRepos, config, context);

    const state: WatcherState = {
      repos: { ...(prevState?.repos ?? {}) },
      discoveredRepos,
      discoveredAt,
    };
    const allLines: string[] = [];

    // Fetch all repos in parallel
    const results = await Promise.all(
      repos.map(async (repo) => {
        const runs = await ghRunList(repo, limit, context.signal);
        let latest = getLatestPerWorkflow(runs, workflowFilter, branchFilter);
        if (maxAgeDays > 0) latest = filterStaleRuns(latest, maxAgeDays);
        return { repo, latest };
      }),
    );

    // Claim repo batches to prevent duplicate reporting across concurrent sessions
    let claimedResults = results;
    if (context.claims) {
      claimedResults = [];
      for (const result of results) {
        // Only claim repos with something to report
        const hasActivity = result.latest.size > 0;
        if (!hasActivity) continue;

        const claimKey = isSessionStart
          ? `${result.repo}:session`
          : `${result.repo}:delta:${[...result.latest.values()].map(r => r.databaseId).sort().join(',')}`;
        const { claimed } = await context.claims.tryClaim(claimKey, 20);
        if (claimed) {
          claimedResults.push(result);
        }
        // Unclaimed repos silently dropped — another session handles them
      }
    }

    for (const { repo, latest } of claimedResults) {
      if (isSessionStart) {
        allLines.push(...formatSessionStart(repo, latest, autonomy));
        state.repos[repo] = buildRepoStateFromLatest(latest, prevState?.repos[repo]);
      } else {
        // Delta mode — only report changes
        const { lines, newState } = detectChanges(repo, latest, prevState?.repos[repo], autonomy);
        state.repos[repo] = newState;
        allLines.push(...lines);
      }
    }

    // Always update state for all fetched repos (even unclaimed ones)
    for (const { repo, latest } of results) {
      state.repos[repo] = buildRepoStateFromLatest(latest, state.repos[repo]);
    }

    // Clean up state for repos no longer watched
    const repoSet = new Set(allRepos);
    for (const key of Object.keys(state.repos)) {
      if (!repoSet.has(key)) delete state.repos[key];
    }

    if (allLines.length === 0) {
      return { text: '', state };
    }

    return { text: allLines.join('\n'), state };
  },

} satisfies AwarenessPlugin<WatcherState>;
