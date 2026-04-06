# agent-awareness-plugins

Monorepo of community provider plugins for the [agent-awareness](https://github.com/edimuj/agent-awareness) Claude Code plugin.
Agent-awareness local: /home/edimuj/projects/oss/agent-awareness/ (this is our project)

## Structure

```
<plugin-name>/
  index.ts              — re-export: `export { default } from './src/index.ts';`
  src/index.ts          — plugin source, exports default AwarenessPlugin<TState>
  package.json          — ESM, exports: "./index.js" (compiled), prepublishOnly build
  README.md             — user-facing docs
tsconfig.build.json     — root build config (shared, emits .js + .d.ts)
```

### CRITICAL: Build Pipeline

Node 24+ blocks TypeScript inside `node_modules/`. All npm-published plugins **must ship compiled `.js`**.

- `package.json` exports must point to `.js` files, not `.ts`
- `tsconfig.build.json` uses `rewriteRelativeImportExtensions` to rewrite `.ts` → `.js` in output
- `npm run build` at root compiles all plugins
- `prepublishOnly` in each plugin runs the build automatically before `npm publish`
- Root `index.ts` re-exports from `src/index.ts` — this is compiled to `index.js` re-exporting `./src/index.js`
- `.js`, `.d.ts`, `.map` are gitignored (build artifacts only exist in published npm packages)

## Plugin Interface (agent-awareness@0.3.0+)

Every plugin exports `default` satisfying `AwarenessPlugin<TState>` from `agent-awareness`:
- `name`, `description`, `triggers: Trigger[]`, `defaults: PluginConfig`
- `gather(trigger, config, prevState: TState | null, context: GatherContext): GatherResult<TState> | null`
- `context.signal?: AbortSignal` — propagate to all I/O
- `context.log?: { warn, error }` — structured logging (falls back to console.error)
- `context.claims?: ClaimContext` — multi-agent event claiming (see below)
- State is generic (`TState extends Record<string, unknown>`) — no cast spam
- MCP is a one-way context pipe (no plugin tools) — plugins inject via `gather()` only

## Multi-agent coordination

All plugins use `context.claims` to prevent duplicate action across concurrent sessions.
Pattern: before acting on an event, call `context.claims.tryClaim(key)`. If claimed by another
session, downgrade to notify or skip.

- **pr-pilot**: claims `act`/`suggest` events, downgrades to notify with "(being handled by another session)"
- **server-health**: claims alert transitions, unclaimed alerts silently suppressed
- **github-watcher**: claims per-repo activity batches, unclaimed repos dropped from output
- **actions-watcher**: claims per-repo workflow batches, unclaimed repos silently dropped
- **claim-debugger**: MCP-only debug tool for inspecting/simulating/testing claims

## Plugins

| Plugin | What it does | Key deps |
|--------|-------------|----------|
| `energy-curve` | Adapts agent style to user energy rhythm by hour/profile | Node builtins |
| `focus-timer` | Pomodoro focus timer (start/break/stop/extend/status) | Node builtins |
| `quota` | Provider-aware usage quotas for Claude and Codex | Claude API / `codex app-server` |
| `system` | Disk, memory, load thresholds with warning labels | Node builtins |
| `weather` | Local weather via Open-Meteo + IP geolocation fallback | Open-Meteo + ip-api.com |
| `github-watcher` | Delta-tracks issues/PRs/comments via `gh` CLI | `gh` CLI |
| `server-health` | Threshold alerts with hysteresis + cooldown | Node builtins |
| `pr-pilot` | Tracks outbound PRs, detects lifecycle events, frames agent actions | `gh` CLI |
| `actions-watcher` | Monitors GitHub Actions workflow runs — failures and recoveries | `gh` CLI |
| `claim-debugger` | Debug tool for testing multi-agent claims | — |

### actions-watcher
- Config: `owner` (auto-discover repos), `repos` (explicit list), `maxAgeDays` (stale filter, default 14), `autonomy` (`"report"` | `"full"`)
- Auto-discovery: on session-start, `gh repo list` → check each for workflow runs → cache in state
- Stale filtering: `filterStaleRuns()` removes workflows with no runs in last N days from output
- Discovery is age-agnostic (finds all repos with any runs), `maxAgeDays` only filters reporting
- 3 MCP tools: check (re-check status), discover (re-discover repos), runs (list recent runs)
- State: `WatcherState` — per-repo workflow tracking + `discoveredRepos[]` cache

### github-watcher
- State: `WatcherState` — per-repo tracking of last seen issue/PR IDs + comment timestamps
- Config: `repos: string[]`, `ignoreAuthors: string[]` (default: empty), `commentLimit`, `format`
- GraphQL for comments, REST for issues/PRs

### server-health
- Collects: disk, memory, load, swap, docker containers, open files
- Hysteresis pattern: alerts at threshold, recovers at `threshold - hysteresis`
- Cooldown prevents oscillation spam. Silent when healthy

### pr-pilot
- Auto-discovers open PRs via `gh search prs --author` + optional repo allowlist
- Event types: checks_failed/passed, review changes/comments/approved, conflicts, mergeable, merged, closed, stale, abandoned, labels
- Autonomy levels per event: `notify` | `suggest` | `act` — controls directive framing
- Dormancy backoff: active PRs every 5m, dormant ~hourly
- Two-stage staleness: warning at `staleDays` (7), removal at `staleTtlDays` (30)
- 5 MCP tools: track, untrack, list, status, check

## Dev Notes

- Source is TypeScript, published output is compiled JS
- Import types from `agent-awareness` (not deep path) — re-exported from main entry
- Only type-only imports from `agent-awareness` survive compilation — runtime imports (like `CLAIMS_DIR`, `createClaimContext` in claim-debugger) require agent-awareness to also ship compiled JS
- `tsconfig.json` at root: `target: ES2022`, `noEmit`, `allowImportingTsExtensions` (dev only)
- `tsconfig.build.json` at root: emits JS + declarations with `rewriteRelativeImportExtensions`
- `agent-awareness` as devDependency via `file:../agent-awareness` (local dev)
- `*.js`, `*.d.ts`, `*.map` gitignored — only exist in published npm packages
- `share/`, `.dev/` gitignored (local artifacts + specs)

### Build & publish workflow
```bash
npm run build                    # compile all plugins (root script)
npm run clean                    # remove all compiled output
cd <plugin> && npm publish       # publish one plugin (prepublishOnly builds)
```

### Testing plugin loading
```bash
cd /path/to/agent-awareness
node src/cli.ts doctor           # shows loaded/failed plugins with errors
```
