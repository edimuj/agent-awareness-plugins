/**
 * actions-watcher — agent-awareness plugin for GitHub Actions monitoring.
 *
 * Tracks workflow run status for configured repos (including private).
 * Reports failures and recoveries — silent when everything is green.
 * Uses `gh` CLI for auth and API access.
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

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function detectChanges(
  repo: string,
  latestRuns: Map<string, WorkflowRun>,
  prevRepoState: RepoState | undefined,
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
      const wasOk = !prev || prev.conclusion === 'success';
      const prefix = wasOk ? '🔴 FAILED' : '🔴 still failing';
      lines.push(`${prefix}: ${repo} / ${wfName} (${run.headBranch}, ${run.event}, ${timeAgo(run.updatedAt)})`);
    } else if (conclusion === 'success' && prev?.conclusion === 'failure') {
      lines.push(`✅ RECOVERED: ${repo} / ${wfName} (${run.headBranch}, ${timeAgo(run.updatedAt)})`);
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
): string[] {
  if (latestRuns.size === 0) return [`${repo}: no workflow runs found`];

  const lines: string[] = [];
  let hasFailure = false;

  for (const [wfName, run] of latestRuns) {
    const conclusion = run.conclusion ?? 'unknown';
    if (conclusion === 'failure') {
      lines.push(`  🔴 ${wfName} (${run.headBranch}): FAILED — ${timeAgo(run.updatedAt)}`);
      hasFailure = true;
    } else if (conclusion === 'success') {
      lines.push(`  ✅ ${wfName} (${run.headBranch}): passing — ${timeAgo(run.updatedAt)}`);
    } else {
      lines.push(`  ⚪ ${wfName} (${run.headBranch}): ${conclusion} — ${timeAgo(run.updatedAt)}`);
    }
  }

  const header = hasFailure
    ? `${repo}: ⚠️ ${latestRuns.size} workflows (failures detected)`
    : `${repo}: ${latestRuns.size} workflows — all green`;

  return [header, ...lines];
}

// --- Plugin ---

export default {
  name: 'actions-watcher',
  description: 'Monitors GitHub Actions workflow runs — reports failures and recoveries',
  triggers: ['session-start', 'interval:5m'],

  defaults: {
    repos: [],
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
    const repos = (config.repos as string[]) ?? [];
    if (repos.length === 0) return null;

    const workflowFilter = (config.workflowFilter as string[]) ?? [];
    const branchFilter = (config.branchFilter as string[]) ?? [];
    const limit = (config.limit as number) ?? 10;
    const isSessionStart = trigger === 'session-start';

    const state: WatcherState = { repos: { ...(prevState?.repos ?? {}) } };
    const allLines: string[] = [];

    // Fetch all repos in parallel
    const results = await Promise.all(
      repos.map(async (repo) => {
        const runs = await ghRunList(repo, limit, context.signal);
        const latest = getLatestPerWorkflow(runs, workflowFilter, branchFilter);
        return { repo, latest };
      }),
    );

    for (const { repo, latest } of results) {
      if (isSessionStart) {
        allLines.push(...formatSessionStart(repo, latest));
      } else {
        // Delta mode — only report changes
        const { lines, newState } = detectChanges(repo, latest, prevState?.repos[repo]);
        state.repos[repo] = newState;
        allLines.push(...lines);
      }

      // Always update state with latest data
      if (isSessionStart) {
        const workflows: Record<string, WorkflowStatus> = {};
        let maxRunId = 0;
        for (const [wfName, run] of latest) {
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
        state.repos[repo] = { workflows, lastCheckedRunId: maxRunId };
      }
    }

    if (allLines.length === 0) return null;

    return { text: allLines.join('\n'), state };
  },

  mcp: {
    tools: [
      {
        name: 'check',
        description: 'Force re-check all configured repos for workflow status changes right now',
        inputSchema: {
          type: 'object' as const,
          properties: {
            repo: {
              type: 'string',
              description: 'Optional: check a specific repo only (owner/name)',
            },
          },
        },
        async handler(
          params: Record<string, unknown>,
          config: PluginConfig,
          signal: AbortSignal,
          prevState: WatcherState | null,
        ) {
          const repos = (config.repos as string[]) ?? [];
          const targetRepo = params.repo as string | undefined;
          const checkRepos = targetRepo ? [targetRepo] : repos;

          if (checkRepos.length === 0) {
            return { text: 'No repos configured. Set repos in plugins.d/actions-watcher.json', state: prevState ?? {} };
          }

          const workflowFilter = (config.workflowFilter as string[]) ?? [];
          const branchFilter = (config.branchFilter as string[]) ?? [];
          const limit = (config.limit as number) ?? 10;
          const lines: string[] = [];

          for (const repo of checkRepos) {
            const runs = await ghRunList(repo, limit, signal);
            const latest = getLatestPerWorkflow(runs, workflowFilter, branchFilter);
            lines.push(...formatSessionStart(repo, latest));
          }

          return {
            text: lines.length > 0 ? lines.join('\n') : 'No workflow runs found',
            state: prevState ?? {},
          };
        },
      },
      {
        name: 'runs',
        description: 'List recent workflow runs for a repo',
        inputSchema: {
          type: 'object' as const,
          properties: {
            repo: {
              type: 'string',
              description: 'Repository (owner/name) — required',
            },
            limit: {
              type: 'number',
              description: 'Number of runs to show (default: 10)',
            },
          },
          required: ['repo'],
        },
        async handler(
          params: Record<string, unknown>,
          _config: PluginConfig,
          signal: AbortSignal,
          prevState: WatcherState | null,
        ) {
          const repo = params.repo as string;
          const limit = (params.limit as number) ?? 10;
          const runs = await ghRunList(repo, limit, signal);

          if (runs.length === 0) {
            return { text: `No workflow runs found for ${repo}`, state: prevState ?? {} };
          }

          const lines = runs.map(r => {
            const status = r.status === 'completed'
              ? (r.conclusion === 'success' ? '✅' : r.conclusion === 'failure' ? '🔴' : `⚪${r.conclusion}`)
              : `⏳${r.status}`;
            return `${status} ${r.workflowName} (${r.headBranch}, ${r.event}) — ${timeAgo(r.updatedAt)}`;
          });

          return {
            text: `${repo} — ${runs.length} recent runs:\n${lines.join('\n')}`,
            state: prevState ?? {},
          };
        },
      },
    ],
  },
} satisfies AwarenessPlugin<WatcherState>;
