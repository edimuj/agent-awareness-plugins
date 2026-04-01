/**
 * pr-pilot — agent-awareness provider plugin
 *
 * Tracks your open PRs on external repos, detects lifecycle events
 * (CI failures, reviews, conflicts, staleness), and surfaces them
 * to the agent with configurable autonomy levels.
 *
 * Plugin = eyes and ears. Agent = brain and hands.
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

type AutonomyLevel = 'notify' | 'suggest' | 'act';

interface AutonomyConfig {
  checksFailure: AutonomyLevel;
  reviewChanges: AutonomyLevel;
  conflicts: AutonomyLevel;
  stale: AutonomyLevel;
  abandoned: AutonomyLevel;
  labels: AutonomyLevel;
}

interface ChecksSnapshot {
  conclusion: 'success' | 'failure' | 'pending' | 'neutral' | null;
  failed: { name: string; details: string }[];
  updatedAt: string;
}

interface ReviewEntry {
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'PENDING';
  updatedAt: string;
}

interface PendingComment {
  reviewer: string;
  body: string;
  path?: string;
  line?: number;
  url: string;
  createdAt: string;
}

interface ReviewSnapshot {
  byReviewer: Record<string, ReviewEntry>;
  pendingComments: PendingComment[];
}

interface PRState {
  url: string;
  repo: string;
  number: number;
  title: string;
  branch: string;
  checks: ChecksSnapshot;
  reviews: ReviewSnapshot;
  mergeable: boolean | null;
  /** Sticky flag for unresolved conflict history when GitHub reports transient UNKNOWN */
  hadConflict?: boolean;
  labels: string[];
  lastActivityAt: string;
  trackedAt: string;
  status: 'open' | 'merged' | 'closed';
  dormant: boolean;
  source: 'auto' | 'manual';
  /** Set to true on the cycle a terminal event fires — removed next cycle */
  pendingRemoval?: boolean;
  /** Set when pr_stale has already fired for this dormancy period */
  staleFired?: boolean;
  /** Set when pr_abandoned has fired */
  abandonedFired?: boolean;
}

interface PilotState extends Record<string, unknown> {
  prs: Record<string, PRState>;
  cycle: number;
  lastDiscovery: string;
  resolvedUsername: string;
}

interface PREvent {
  type:
    | 'checks_failed'
    | 'checks_passed'
    | 'review_requested_changes'
    | 'review_commented'
    | 'review_approved'
    | 'conflict_detected'
    | 'now_mergeable'
    | 'pr_merged'
    | 'pr_closed'
    | 'pr_stale'
    | 'pr_abandoned'
    | 'label_added';
  pr: string;
  details?: string;
  /** Set when another agent session has already claimed this event */
  claimedByOther?: boolean;
}

type Log = NonNullable<GatherContext['log']>;

// ── Helpers ────────────────────────────────────────────────────────────────

function makeLog(ctx?: { log?: Log }): Log {
  return ctx?.log ?? { warn: console.error, error: console.error };
}

function prKey(repo: string, number: number): string {
  return `${repo}#${number}`;
}

function parsePrRef(ref: string): { repo: string; number: number } | null {
  // https://github.com/owner/repo/pull/123
  const urlMatch = ref.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (urlMatch) return { repo: urlMatch[1], number: parseInt(urlMatch[2], 10) };

  // owner/repo#123
  const shortMatch = ref.match(/^([^/]+\/[^#]+)#(\d+)$/);
  if (shortMatch) return { repo: shortMatch[1], number: parseInt(shortMatch[2], 10) };

  return null;
}

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / (1000 * 60 * 60 * 24);
}

async function gh(args: string[], log: Log, signal?: AbortSignal): Promise<string> {
  try {
    const { stdout } = await exec('gh', args, {
      timeout: 30_000,
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

// ── Username resolution ───────────────────────────────────────────────────

async function resolveUsername(
  config: PluginConfig,
  state: PilotState,
  log: Log,
  signal?: AbortSignal,
): Promise<string> {
  const configured = config.username as string;
  if (configured) return configured;
  if (state.resolvedUsername) return state.resolvedUsername;

  const result = await gh(['api', 'user', '-q', '.login'], log, signal);
  return result || '';
}

// ── Discovery ─────────────────────────────────────────────────────────────

interface DiscoveredPR {
  repo: string;
  number: number;
  title: string;
  url: string;
  updatedAt: string;
}

function repoOwner(repo: string): string {
  return repo.split('/')[0]?.toLowerCase() ?? '';
}

const CONTROLLED_PERMISSIONS = new Set(['ADMIN', 'MAINTAIN', 'WRITE']);

async function hasWriteControl(
  repo: string,
  log: Log,
  signal: AbortSignal | undefined,
  cache: Map<string, boolean>,
): Promise<boolean> {
  const cached = cache.get(repo);
  if (cached !== undefined) return cached;

  const permission = await gh(
    ['repo', 'view', repo, '--json', 'viewerPermission', '-q', '.viewerPermission'],
    log,
    signal,
  );
  const controlled = CONTROLLED_PERMISSIONS.has(permission.trim().toUpperCase());
  cache.set(repo, controlled);
  return controlled;
}

async function discoverOpenPRs(
  username: string,
  repos: string[],
  includeOwnRepos: boolean,
  includeControlledOrgRepos: boolean,
  log: Log,
  signal?: AbortSignal,
): Promise<DiscoveredPR[]> {
  const json = await gh([
    'search', 'prs',
    '--author', username,
    '--state', 'open',
    '--json', 'number,title,repository,url,updatedAt',
    '--limit', '100',
  ], log, signal);

  if (!json) return [];

  try {
    const results: Array<{
      number: number;
      title: string;
      repository: { nameWithOwner: string };
      url: string;
      updatedAt: string;
    }> = JSON.parse(json);

    const usernameLower = username.toLowerCase();
    const prelim = results.filter((r) => repos.length === 0 || repos.includes(r.repository.nameWithOwner));
    const controlCache = new Map<string, boolean>();

    const selected = await Promise.all(prelim.map(async (r) => {
      const owner = repoOwner(r.repository.nameWithOwner);
      if (owner === usernameLower) {
        return includeOwnRepos ? r : null;
      }
      if (includeControlledOrgRepos) return r;
      const controlled = await hasWriteControl(r.repository.nameWithOwner, log, signal, controlCache);
      return controlled ? null : r;
    }));

    return selected
      .filter((r): r is typeof prelim[number] => r !== null)
      .map((r) => ({
        repo: r.repository.nameWithOwner,
        number: r.number,
        title: r.title,
        url: r.url,
        updatedAt: r.updatedAt,
      }));
  } catch {
    log.warn('Failed to parse PR discovery results');
    return [];
  }
}

// ── PR data fetching (GraphQL) ────────────────────────────────────────────

const PR_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      title
      headRefName
      url
      state
      mergeable
      updatedAt
      labels(first: 20) {
        nodes { name }
      }
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 50) {
                nodes {
                  ... on CheckRun {
                    __typename
                    name
                    conclusion
                    title
                  }
                  ... on StatusContext {
                    __typename
                    context
                    state
                    description
                  }
                }
              }
            }
          }
        }
      }
      reviews(last: 20) {
        nodes {
          author { login }
          state
          submittedAt
        }
      }
      reviewThreads(first: 50) {
        nodes {
          isResolved
          comments(first: 1) {
            nodes {
              author { login }
              body
              path
              originalLine
              url
              createdAt
            }
          }
        }
      }
    }
  }
}`;

interface GQLCheckNode {
  __typename: string;
  name?: string;
  conclusion?: string | null;
  title?: string;
  context?: string;
  state?: string;
  description?: string;
}

interface GQLReviewNode {
  author: { login: string } | null;
  state: string;
  submittedAt: string;
}

interface GQLThreadNode {
  isResolved: boolean;
  comments: {
    nodes: Array<{
      author: { login: string } | null;
      body: string;
      path: string | null;
      originalLine: number | null;
      url: string;
      createdAt: string;
    }>;
  };
}

interface FetchedPRData {
  title: string;
  branch: string;
  url: string;
  ghState: string;
  mergeable: string;
  updatedAt: string;
  labels: string[];
  checks: ChecksSnapshot;
  reviews: ReviewSnapshot;
}

async function fetchPRData(
  repo: string,
  number: number,
  log: Log,
  signal?: AbortSignal,
): Promise<FetchedPRData | null> {
  const [owner, name] = repo.split('/');
  if (!owner || !name) return null;

  const json = await gh([
    'api', 'graphql',
    '-f', `query=${PR_QUERY}`,
    '-f', `owner=${owner}`,
    '-f', `repo=${name}`,
    '-F', `number=${number}`,
  ], log, signal);

  if (!json) return null;

  try {
    const data = JSON.parse(json);
    const pr = data.data?.repository?.pullRequest;
    if (!pr) return null;

    // Parse checks
    const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    const checkNodes: GQLCheckNode[] = rollup?.contexts?.nodes ?? [];
    const failed = checkNodes
      .filter((n) => {
        if (n.__typename === 'CheckRun') return n.conclusion === 'FAILURE' || n.conclusion === 'ACTION_REQUIRED';
        if (n.__typename === 'StatusContext') return n.state === 'FAILURE' || n.state === 'ERROR';
        return false;
      })
      .map((n) => ({
        name: n.name ?? n.context ?? 'unknown',
        details: n.title ?? n.description ?? '',
      }));

    const rollupState = rollup?.state?.toLowerCase() ?? null;
    const checksConclusion = rollupState === 'success' ? 'success'
      : rollupState === 'failure' || rollupState === 'error' ? 'failure'
      : rollupState === 'pending' ? 'pending'
      : rollupState === 'neutral' ? 'neutral'
      : null;

    const checks: ChecksSnapshot = {
      conclusion: checksConclusion as ChecksSnapshot['conclusion'],
      failed,
      updatedAt: pr.updatedAt,
    };

    // Parse reviews — latest per reviewer
    const reviewNodes: GQLReviewNode[] = pr.reviews?.nodes ?? [];
    const byReviewer: Record<string, ReviewEntry> = {};
    for (const r of reviewNodes) {
      const login = r.author?.login;
      if (!login) continue;
      const existing = byReviewer[login];
      if (!existing || r.submittedAt > existing.updatedAt) {
        byReviewer[login] = {
          state: r.state as ReviewEntry['state'],
          updatedAt: r.submittedAt,
        };
      }
    }

    // Parse unresolved review threads
    const threadNodes: GQLThreadNode[] = pr.reviewThreads?.nodes ?? [];
    const pendingComments: PendingComment[] = threadNodes
      .filter((t) => !t.isResolved && t.comments.nodes.length > 0)
      .map((t) => {
        const c = t.comments.nodes[0];
        return {
          reviewer: c.author?.login ?? 'unknown',
          body: c.body,
          path: c.path ?? undefined,
          line: c.originalLine ?? undefined,
          url: c.url,
          createdAt: c.createdAt,
        };
      });

    const reviews: ReviewSnapshot = { byReviewer, pendingComments };

    // Parse labels
    const labels: string[] = (pr.labels?.nodes ?? []).map((l: { name: string }) => l.name);

    // Parse mergeable
    const mergeableStr: string = pr.mergeable ?? 'UNKNOWN';

    return {
      title: pr.title,
      branch: pr.headRefName,
      url: pr.url,
      ghState: pr.state,
      mergeable: mergeableStr,
      updatedAt: pr.updatedAt,
      labels,
      checks,
      reviews,
    };
  } catch (err) {
    log.warn(`Failed to parse PR data for ${repo}#${number}: ${err}`);
    return null;
  }
}

// ── Event detection ───────────────────────────────────────────────────────

function detectEvents(
  key: string,
  prev: PRState,
  data: FetchedPRData,
  staleDays: number,
  staleTtlDays: number,
): PREvent[] {
  const events: PREvent[] = [];
  const prevFailureSignature = prev.checks.failed.map((f) => `${f.name}:${f.details}`).sort().join('|');
  const nextFailureSignature = data.checks.failed.map((f) => `${f.name}:${f.details}`).sort().join('|');

  // Terminal states
  if (data.ghState === 'MERGED' && prev.status === 'open') {
    events.push({ type: 'pr_merged', pr: key });
    return events;
  }
  if (data.ghState === 'CLOSED' && prev.status === 'open') {
    events.push({ type: 'pr_closed', pr: key });
    return events;
  }

  // CI checks
  if (
    data.checks.conclusion === 'failure'
    && (
      prev.checks.conclusion !== 'failure'
      || data.checks.updatedAt > prev.checks.updatedAt
      || nextFailureSignature !== prevFailureSignature
    )
  ) {
    const details = data.checks.failed.map((f) => f.name).join(', ');
    events.push({ type: 'checks_failed', pr: key, details: `${data.checks.failed.length} failed: ${details}` });
  }
  if (data.checks.conclusion === 'success' && prev.checks.conclusion === 'failure') {
    events.push({ type: 'checks_passed', pr: key });
  }

  // Reviews — detect new states per reviewer
  for (const [reviewer, entry] of Object.entries(data.reviews.byReviewer)) {
    const prevEntry = prev.reviews.byReviewer[reviewer];
    if (entry.state === 'CHANGES_REQUESTED' && prevEntry?.state !== 'CHANGES_REQUESTED') {
      const comments = data.reviews.pendingComments
        .filter((c) => c.reviewer === reviewer)
        .map((c) => c.body.slice(0, 100))
        .join('; ');
      events.push({
        type: 'review_requested_changes',
        pr: key,
        details: `@${reviewer}: ${comments || 'changes requested'}`,
      });
    }
    if (entry.state === 'COMMENTED' && (!prevEntry || entry.updatedAt > (prevEntry.updatedAt ?? ''))) {
      events.push({
        type: 'review_commented',
        pr: key,
        details: `@${reviewer} commented`,
      });
    }
    if (entry.state === 'APPROVED' && prevEntry?.state !== 'APPROVED') {
      events.push({ type: 'review_approved', pr: key, details: `@${reviewer}` });
    }
  }

  // Merge conflicts
  const prevHadConflict = prev.hadConflict ?? (prev.mergeable === false);
  const nowMergeable = data.mergeable === 'MERGEABLE' ? true : data.mergeable === 'CONFLICTING' ? false : null;
  if (nowMergeable === false && !prevHadConflict) {
    events.push({ type: 'conflict_detected', pr: key });
  }
  if (nowMergeable === true && prevHadConflict) {
    events.push({ type: 'now_mergeable', pr: key });
  }

  // Labels
  const newLabels = data.labels.filter((l) => !prev.labels.includes(l));
  if (newLabels.length > 0) {
    events.push({ type: 'label_added', pr: key, details: newLabels.join(', ') });
  }

  // Staleness (only when no other events fired — don't pile on)
  if (events.length === 0) {
    const inactiveDays = daysSince(data.updatedAt);
    if (inactiveDays >= staleTtlDays && !prev.abandonedFired) {
      events.push({ type: 'pr_abandoned', pr: key, details: `${Math.floor(inactiveDays)} days inactive` });
    } else if (inactiveDays >= staleDays && !prev.staleFired) {
      events.push({ type: 'pr_stale', pr: key, details: `${Math.floor(inactiveDays)} days inactive` });
    }
  }

  return events;
}

// ── Autonomy framing ──────────────────────────────────────────────────────

function getAutonomyLevel(event: PREvent, autonomy: AutonomyConfig): AutonomyLevel {
  switch (event.type) {
    case 'checks_failed': return autonomy.checksFailure;
    case 'review_requested_changes': return autonomy.reviewChanges;
    case 'conflict_detected': return autonomy.conflicts;
    case 'pr_stale': return autonomy.stale;
    case 'pr_abandoned': return autonomy.abandoned;
    case 'label_added': return autonomy.labels;
    default: return 'notify';
  }
}

function eventClaimFingerprint(event: PREvent, pr: PRState | undefined): string {
  if (!pr) return event.details ?? '';

  if (event.type === 'checks_failed' || event.type === 'checks_passed') {
    const failed = pr.checks.failed.map((f) => `${f.name}:${f.details}`).sort().join('|');
    return `${pr.checks.updatedAt}|${pr.checks.conclusion ?? 'none'}|${failed}`;
  }

  if (
    event.type === 'review_requested_changes'
    || event.type === 'review_commented'
    || event.type === 'review_approved'
  ) {
    return Object.entries(pr.reviews.byReviewer)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reviewer, entry]) => `${reviewer}:${entry.state}:${entry.updatedAt}`)
      .join('|');
  }

  if (event.type === 'label_added') {
    return `${event.details ?? ''}|${pr.lastActivityAt}`;
  }

  return `${pr.status}|${pr.lastActivityAt}|${event.details ?? ''}`;
}

function eventClaimKey(event: PREvent, pr: PRState | undefined): string {
  return `${event.pr}:${event.type}:${eventClaimFingerprint(event, pr)}`;
}

const SUGGESTIONS: Record<string, string> = {
  checks_failed: 'clone repo, fix failing checks, run tests locally, push fix commit',
  review_requested_changes: 'review the feedback, address each comment, push changes, respond to reviewer',
  conflict_detected: 'rebase branch onto upstream default branch, resolve conflicts, force-push',
  pr_stale: 'ping the maintainer with a polite follow-up comment',
  pr_abandoned: 'consider closing the PR and re-evaluating if the contribution is still relevant',
  label_added: 'check if the label implies an action is needed (e.g. needs-rebase)',
};

function frameEvent(event: PREvent, autonomy: AutonomyConfig, prTitle: string): string {
  const level = getAutonomyLevel(event, autonomy);
  const base = formatEventBase(event, prTitle);

  // Another agent claimed this event — downgrade to notify
  if (event.claimedByOther) return `${base} (being handled by another session)`;

  if (level === 'notify') return base;

  const suggestion = SUGGESTIONS[event.type];
  if (!suggestion) return base;

  if (level === 'suggest') return `${base}. Suggested: ${suggestion}`;
  return `${base}. Action required: ${suggestion}`;
}

function formatEventBase(event: PREvent, prTitle: string): string {
  const ref = `${event.pr} "${prTitle}"`;
  switch (event.type) {
    case 'checks_failed': return `CI failed on ${ref}: ${event.details}`;
    case 'checks_passed': return `CI now passing on ${ref}`;
    case 'review_requested_changes': return `Changes requested on ${ref}: ${event.details}`;
    case 'review_commented': return `New review comment on ${ref}: ${event.details}`;
    case 'review_approved': return `Approved: ${ref} by ${event.details}`;
    case 'conflict_detected': return `Merge conflict on ${ref}`;
    case 'now_mergeable': return `Now mergeable: ${ref}`;
    case 'pr_merged': return `Merged: ${ref}`;
    case 'pr_closed': return `Closed without merge: ${ref}`;
    case 'pr_stale': return `Stale PR: ${ref} (${event.details})`;
    case 'pr_abandoned': return `Abandoned PR: ${ref} (${event.details})`;
    case 'label_added': return `Labels added on ${ref}: ${event.details}`;
    default: return `Event on ${ref}`;
  }
}

// ── Formatters ────────────────────────────────────────────────────────────

function formatDashboard(state: PilotState, autonomy: AutonomyConfig): string {
  const prs = Object.entries(state.prs);
  if (prs.length === 0) return 'PR Pilot: no tracked PRs';

  const needsAction: string[] = [];
  const waiting: string[] = [];
  const dormant: string[] = [];

  for (const [key, pr] of prs) {
    if (pr.status !== 'open') continue;

    const issues: string[] = [];
    if (pr.checks.conclusion === 'failure') {
      issues.push(`CI failed: ${pr.checks.failed.map((f) => f.name).join(', ')}`);
    }
    const changesRequested = Object.entries(pr.reviews.byReviewer)
      .filter(([, r]) => r.state === 'CHANGES_REQUESTED');
    if (changesRequested.length > 0) {
      issues.push(`Review: ${changesRequested.map(([r]) => `@${r}`).join(', ')} requested changes`);
    }
    if (pr.reviews.pendingComments.length > 0) {
      issues.push(`${pr.reviews.pendingComments.length} unresolved comment${pr.reviews.pendingComments.length > 1 ? 's' : ''}`);
    }
    if (pr.mergeable === false) {
      issues.push('Merge conflict');
    }

    const line = `  ${key} — ${pr.title}`;
    if (issues.length > 0) {
      needsAction.push(`${line}\n    ${issues.join('; ')}`);
    } else if (pr.dormant) {
      const days = Math.floor(daysSince(pr.lastActivityAt));
      dormant.push(`${line}\n    No activity for ${days} day${days !== 1 ? 's' : ''}`);
    } else {
      const statusParts: string[] = [];
      if (pr.checks.conclusion === 'success') statusParts.push('checks passing');
      const approvals = Object.values(pr.reviews.byReviewer).filter((r) => r.state === 'APPROVED').length;
      if (approvals > 0) statusParts.push(`${approvals} approval${approvals > 1 ? 's' : ''}`);
      waiting.push(`${line}\n    ${statusParts.join(', ') || 'waiting'}`);
    }
  }

  const sections: string[] = [];
  const openCount = prs.filter(([, pr]) => pr.status === 'open').length;
  sections.push(`PR Pilot: ${openCount} tracked PR${openCount !== 1 ? 's' : ''}`);

  if (needsAction.length) sections.push(`\n🔴 Needs action:\n${needsAction.join('\n')}`);
  if (waiting.length) sections.push(`\n⏳ Waiting:\n${waiting.join('\n')}`);
  if (dormant.length) sections.push(`\n💤 Dormant:\n${dormant.join('\n')}`);

  return sections.join('\n');
}

function formatEvents(events: PREvent[], state: PilotState, autonomy: AutonomyConfig): string {
  if (events.length === 0) return '';
  const lines = events.map((e) => {
    const pr = state.prs[e.pr];
    return frameEvent(e, autonomy, pr?.title ?? '');
  });
  return `PR Pilot: ${lines.join(' | ')}`;
}

// ── State helpers ─────────────────────────────────────────────────────────

function buildPRState(data: FetchedPRData, source: 'auto' | 'manual'): PRState {
  const now = new Date().toISOString();
  const mergeable = data.mergeable === 'MERGEABLE' ? true : data.mergeable === 'CONFLICTING' ? false : null;
  return {
    url: data.url,
    repo: '',
    number: 0,
    title: data.title,
    branch: data.branch,
    checks: data.checks,
    reviews: data.reviews,
    mergeable,
    hadConflict: mergeable === false,
    labels: data.labels,
    lastActivityAt: data.updatedAt,
    trackedAt: now,
    status: data.ghState === 'MERGED' ? 'merged' : data.ghState === 'CLOSED' ? 'closed' : 'open',
    dormant: false,
    source,
  };
}

function updatePRState(prev: PRState, data: FetchedPRData, events: PREvent[]): PRState {
  const nowMergeable = data.mergeable === 'MERGEABLE' ? true : data.mergeable === 'CONFLICTING' ? false : null;
  const hadConflict = nowMergeable === false
    ? true
    : nowMergeable === true
      ? false
      : (prev.hadConflict ?? (prev.mergeable === false));

  const updated: PRState = {
    ...prev,
    title: data.title,
    branch: data.branch,
    url: data.url,
    checks: data.checks,
    reviews: data.reviews,
    mergeable: nowMergeable,
    hadConflict,
    labels: data.labels,
    lastActivityAt: data.updatedAt,
    status: data.ghState === 'MERGED' ? 'merged' : data.ghState === 'CLOSED' ? 'closed' : 'open',
    dormant: daysSince(data.updatedAt) >= 1,
  };

  // Track staleness flags
  if (events.some((e) => e.type === 'pr_stale')) updated.staleFired = true;
  if (events.some((e) => e.type === 'pr_abandoned')) updated.abandonedFired = true;

  // Reset stale flags if activity resumed
  if (data.updatedAt > prev.lastActivityAt) {
    updated.staleFired = false;
    updated.abandonedFired = false;
    updated.dormant = false;
  }

  // Mark for removal on terminal events
  if (events.some((e) => e.type === 'pr_merged' || e.type === 'pr_closed' || e.type === 'pr_abandoned')) {
    updated.pendingRemoval = true;
  }

  return updated;
}

function getAutonomyConfig(config: PluginConfig): AutonomyConfig {
  const a = (config.autonomy ?? {}) as Partial<AutonomyConfig>;
  return {
    checksFailure: a.checksFailure ?? 'act',
    reviewChanges: a.reviewChanges ?? 'suggest',
    conflicts: a.conflicts ?? 'suggest',
    stale: a.stale ?? 'notify',
    abandoned: a.abandoned ?? 'suggest',
    labels: a.labels ?? 'notify',
  };
}

// ── Plugin ─────────────────────────────────────────────────────────────────

const DISCOVERY_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

export default {
  name: 'pr-pilot',
  description: 'Tracks outbound PRs on external repos — detects CI failures, reviews, conflicts, staleness, and frames agent actions',

  triggers: ['session-start', 'interval:5m'],

  defaults: {
    enabled: true,
    autoDiscover: true,
    includeOwnRepos: false,
    includeControlledOrgRepos: false,
    repos: [] as string[],
    username: '',
    autonomy: {
      checksFailure: 'act' as AutonomyLevel,
      reviewChanges: 'suggest' as AutonomyLevel,
      conflicts: 'suggest' as AutonomyLevel,
      stale: 'notify' as AutonomyLevel,
      abandoned: 'suggest' as AutonomyLevel,
      labels: 'notify' as AutonomyLevel,
    },
    staleDays: 7,
    staleTtlDays: 30,
    dormantBackoffCycles: 12,
    triggers: {
      'session-start': 'dashboard',
      'interval:5m': 'events',
    },
  },

  async gather(
    trigger: Trigger,
    config: PluginConfig,
    prevState: PilotState | null,
    context: GatherContext,
  ): Promise<GatherResult<PilotState> | null> {
    const log = makeLog(context);
    const signal = context.signal;
    const autonomy = getAutonomyConfig(config);
    const staleDays = (config.staleDays as number) ?? 7;
    const staleTtlDays = (config.staleTtlDays as number) ?? 30;
    const dormantBackoffCycles = (config.dormantBackoffCycles as number) ?? 12;
    const repos = (config.repos as string[]) ?? [];
    const includeOwnRepos = config.includeOwnRepos === true;
    const includeControlledOrgRepos = config.includeControlledOrgRepos === true;
    const autoDiscover = config.autoDiscover !== false;

    const now = new Date().toISOString();
    const state: PilotState = prevState ?? {
      prs: {},
      cycle: 0,
      lastDiscovery: '',
      resolvedUsername: '',
    };
    const allEvents: PREvent[] = [];

    // Resolve username
    if (!state.resolvedUsername) {
      state.resolvedUsername = await resolveUsername(config, state, log, signal);
      if (!state.resolvedUsername) {
        log.warn('Could not resolve GitHub username — set "username" in config or run "gh auth login"');
        return null;
      }
    }

    // Remove PRs marked for removal in previous cycle
    for (const [key, pr] of Object.entries(state.prs)) {
      if (pr.pendingRemoval) delete state.prs[key];
    }

    // Auto-discovery: on session-start, or every 30 minutes
    const shouldDiscover = autoDiscover && (
      trigger === 'session-start'
      || !state.lastDiscovery
      || (Date.now() - new Date(state.lastDiscovery).getTime()) > DISCOVERY_INTERVAL_MS
    );

    if (shouldDiscover) {
      const discovered = await discoverOpenPRs(
        state.resolvedUsername,
        repos,
        includeOwnRepos,
        includeControlledOrgRepos,
        log,
        signal,
      );
      for (const d of discovered) {
        const key = prKey(d.repo, d.number);
        if (!state.prs[key]) {
          // New PR — fetch full data
          const data = await fetchPRData(d.repo, d.number, log, signal);
          if (data) {
            const prState = buildPRState(data, 'auto');
            prState.repo = d.repo;
            prState.number = d.number;
            state.prs[key] = prState;
          }
        }
      }
      state.lastDiscovery = now;

      // Remove auto-discovered PRs that are no longer in discovery results
      const discoveredKeys = new Set(discovered.map((d) => prKey(d.repo, d.number)));
      for (const [key, pr] of Object.entries(state.prs)) {
        if (pr.source === 'auto' && !discoveredKeys.has(key)) {
          // PR was closed/merged externally — fetch to confirm
          const data = await fetchPRData(pr.repo, pr.number, log, signal);
          if (!data) continue;
          if (data.ghState === 'OPEN') {
            state.prs[key] = updatePRState(pr, data, []);
            continue;
          }

          const terminalEvent: PREvent = {
            type: data.ghState === 'MERGED' ? 'pr_merged' : 'pr_closed',
            pr: key,
          };
          allEvents.push(terminalEvent);
          state.prs[key] = updatePRState(pr, data, [terminalEvent]);
        }
      }
    }

    // Increment cycle
    state.cycle = (state.cycle + 1);

    // Fetch data and detect events for tracked PRs
    const prEntries = Object.entries(state.prs);

    for (const [key, pr] of prEntries) {
      if (pr.status !== 'open') continue;

      // Dormancy backoff
      if (pr.dormant && trigger !== 'session-start' && state.cycle % dormantBackoffCycles !== 0) {
        continue;
      }

      const data = await fetchPRData(pr.repo, pr.number, log, signal);
      if (!data) continue;

      const events = detectEvents(key, pr, data, staleDays, staleTtlDays);
      allEvents.push(...events);
      state.prs[key] = updatePRState(pr, data, events);
    }

    // Claim actionable events to prevent duplicate work across sessions
    if (context.claims) {
      for (const event of allEvents) {
        const level = getAutonomyLevel(event, autonomy);
        if (level === 'act' || level === 'suggest') {
          const claimKey = eventClaimKey(event, state.prs[event.pr]);
          const { claimed } = await context.claims.tryClaim(claimKey);
          if (!claimed) {
            event.claimedByOther = true;
          }
        }
      }
    }

    // Format output
    const triggerFormat = config.triggers?.[trigger as string];
    const isDashboard = triggerFormat === 'dashboard' || trigger === 'session-start';

    const text = isDashboard
      ? formatDashboard(state, autonomy)
      : formatEvents(allEvents, state, autonomy);

    // Silent when nothing to report on interval
    if (!isDashboard && !text) {
      return { text: '', state };
    }

    return { text, state };
  },

  mcp: {
    tools: [
      {
        name: 'track',
        description: 'Manually track a PR. Accepts GitHub URL or owner/repo#number shorthand.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            url: {
              type: 'string',
              description: 'PR reference: https://github.com/owner/repo/pull/123 or owner/repo#123',
            },
          },
          required: ['url'],
        },
        async handler(
          params: Record<string, unknown>,
          _config: PluginConfig,
          signal: AbortSignal,
          prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const log = makeLog();
          const ref = parsePrRef(params.url as string);
          if (!ref) return { text: `Invalid PR reference: ${params.url}. Use owner/repo#123 or a GitHub URL.` };

          const state = (prevState as PilotState | null) ?? { prs: {}, cycle: 0, lastDiscovery: '', resolvedUsername: '' };
          const key = prKey(ref.repo, ref.number);

          if (state.prs[key]) {
            return { text: `Already tracking ${key}: ${state.prs[key].title}` };
          }

          const data = await fetchPRData(ref.repo, ref.number, log, signal);
          if (!data) return { text: `Could not fetch PR data for ${key}. Check that the PR exists and gh is authenticated.` };

          const prState = buildPRState(data, 'manual');
          prState.repo = ref.repo;
          prState.number = ref.number;
          state.prs[key] = prState;

          return {
            text: `Tracking ${key}: ${data.title} (${data.ghState.toLowerCase()}, checks: ${data.checks.conclusion ?? 'none'})`,
            state,
          };
        },
      },
      {
        name: 'untrack',
        description: 'Stop tracking a PR.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            pr: {
              type: 'string',
              description: 'PR key: owner/repo#123',
            },
          },
          required: ['pr'],
        },
        async handler(
          params: Record<string, unknown>,
          _config: PluginConfig,
          _signal: AbortSignal,
          prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const state = (prevState as PilotState | null) ?? { prs: {}, cycle: 0, lastDiscovery: '', resolvedUsername: '' };
          const pr = params.pr as string;

          if (!state.prs[pr]) {
            return { text: `Not tracking: ${pr}` };
          }

          const title = state.prs[pr].title;
          delete state.prs[pr];
          return { text: `Stopped tracking ${pr}: ${title}`, state };
        },
      },
      {
        name: 'list',
        description: 'List all tracked PRs with status summary.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            status: {
              type: 'string',
              description: 'Filter by status: open, stale, or all (default: open)',
              enum: ['open', 'stale', 'all'],
            },
          },
        },
        async handler(
          params: Record<string, unknown>,
          config: PluginConfig,
          _signal: AbortSignal,
          prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const state = (prevState as PilotState | null) ?? { prs: {}, cycle: 0, lastDiscovery: '', resolvedUsername: '' };
          const filter = (params.status as string) ?? 'open';
          const staleDays = (config.staleDays as number) ?? 7;

          const entries = Object.entries(state.prs).filter(([, pr]) => {
            if (filter === 'all') return true;
            if (filter === 'stale') return pr.status === 'open' && daysSince(pr.lastActivityAt) >= staleDays;
            return pr.status === 'open';
          });

          if (entries.length === 0) return { text: `No ${filter} PRs tracked` };

          const lines = entries.map(([key, pr]) => {
            const checks = pr.checks.conclusion ?? 'none';
            const reviews = Object.values(pr.reviews.byReviewer)
              .filter((r) => r.state === 'APPROVED').length;
            const days = Math.floor(daysSince(pr.lastActivityAt));
            const dormantTag = pr.dormant ? ' 💤' : '';
            return `${key} — ${pr.title}\n  checks: ${checks} | approvals: ${reviews} | inactive: ${days}d | source: ${pr.source}${dormantTag}`;
          });

          return { text: `Tracked PRs (${filter}):\n${lines.join('\n')}` };
        },
      },
      {
        name: 'status',
        description: 'Get detailed status for a specific tracked PR.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            pr: {
              type: 'string',
              description: 'PR key: owner/repo#123',
            },
          },
          required: ['pr'],
        },
        async handler(
          params: Record<string, unknown>,
          _config: PluginConfig,
          signal: AbortSignal,
          prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const log = makeLog();
          const state = (prevState as PilotState | null) ?? { prs: {}, cycle: 0, lastDiscovery: '', resolvedUsername: '' };
          const key = params.pr as string;
          const pr = state.prs[key];

          if (!pr) return { text: `Not tracking: ${key}` };

          // Fetch fresh data
          const data = await fetchPRData(pr.repo, pr.number, log, signal);
          if (data) {
            state.prs[key] = updatePRState(pr, data, []);
          }

          const current = state.prs[key];
          const lines = [
            `**${key}** — ${current.title}`,
            `Branch: ${current.branch}`,
            `Status: ${current.status} | Mergeable: ${current.mergeable ?? 'unknown'}`,
            `Checks: ${current.checks.conclusion ?? 'none'}`,
          ];

          if (current.checks.failed.length > 0) {
            lines.push(`Failed checks: ${current.checks.failed.map((f) => `${f.name} (${f.details})`).join(', ')}`);
          }

          const reviewLines = Object.entries(current.reviews.byReviewer)
            .map(([r, entry]) => `@${r}: ${entry.state}`);
          if (reviewLines.length > 0) {
            lines.push(`Reviews: ${reviewLines.join(', ')}`);
          }

          if (current.reviews.pendingComments.length > 0) {
            lines.push(`Unresolved comments: ${current.reviews.pendingComments.length}`);
            for (const c of current.reviews.pendingComments.slice(0, 5)) {
              const preview = c.body.slice(0, 80).replace(/\n/g, ' ');
              const loc = c.path ? ` (${c.path}${c.line ? `:${c.line}` : ''})` : '';
              lines.push(`  @${c.reviewer}${loc}: ${preview}${c.body.length > 80 ? '…' : ''}`);
            }
          }

          if (current.labels.length > 0) {
            lines.push(`Labels: ${current.labels.join(', ')}`);
          }

          const days = Math.floor(daysSince(current.lastActivityAt));
          lines.push(`Last activity: ${days} day${days !== 1 ? 's' : ''} ago | Tracked since: ${current.trackedAt.split('T')[0]} | Source: ${current.source}`);

          return { text: lines.join('\n'), state };
        },
      },
      {
        name: 'check',
        description: 'Force re-check a specific PR right now, skipping dormancy backoff.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            pr: {
              type: 'string',
              description: 'PR key: owner/repo#123',
            },
          },
          required: ['pr'],
        },
        async handler(
          params: Record<string, unknown>,
          config: PluginConfig,
          signal: AbortSignal,
          prevState: Record<string, unknown> | null,
        ): Promise<GatherResult | null> {
          const log = makeLog();
          const autonomy = getAutonomyConfig(config);
          const staleDays = (config.staleDays as number) ?? 7;
          const staleTtlDays = (config.staleTtlDays as number) ?? 30;
          const state = (prevState as PilotState | null) ?? { prs: {}, cycle: 0, lastDiscovery: '', resolvedUsername: '' };
          const key = params.pr as string;
          const pr = state.prs[key];

          if (!pr) return { text: `Not tracking: ${key}` };

          const data = await fetchPRData(pr.repo, pr.number, log, signal);
          if (!data) return { text: `Could not fetch data for ${key}` };

          const events = detectEvents(key, pr, data, staleDays, staleTtlDays);
          state.prs[key] = updatePRState(pr, data, events);

          const eventText = events.length > 0
            ? events.map((e) => frameEvent(e, autonomy, pr.title)).join('\n')
            : 'No new events';

          return { text: `${key}: ${eventText}`, state };
        },
      },
    ],
  },
} satisfies AwarenessPlugin<PilotState>;
