# agent-awareness-plugins

Community provider plugins for [agent-awareness](https://github.com/edimuj/agent-awareness).

## Plugins

| Plugin | Description | npm |
|--------|-------------|-----|
| [energy-curve](./energy-curve/) | Adapts agent style to user energy rhythm by hour/profile | `agent-awareness-plugin-energy-curve` |
| [quota](./quota/) | Provider-aware quota visibility for Claude/Codex | `agent-awareness-plugin-quota` |
| [system](./system/) | Disk, memory, and load threshold warnings | `agent-awareness-plugin-system` |
| [weather](./weather/) | Local weather context via Open-Meteo | `agent-awareness-plugin-weather` |
| [github-watcher](./github-watcher/) | Monitors GitHub repos for new issues, PRs, and comments | `agent-awareness-plugin-github-watcher` |
| [server-health](./server-health/) | Threshold-based server alerts with hysteresis and cooldown | `agent-awareness-plugin-server-health` |
| [pr-pilot](./pr-pilot/) | Tracks outbound PRs — detects CI failures, reviews, conflicts, staleness | `agent-awareness-plugin-pr-pilot` |
| [actions-watcher](./actions-watcher/) | Monitors GitHub Actions workflows — auto-discovers repos, reports failures and recoveries | `agent-awareness-plugin-actions-watcher` |

## Installation

```bash
# Install plugins globally (recommended)
npm install -g agent-awareness-plugin-github-watcher
npm install -g agent-awareness-plugin-server-health
npm install -g agent-awareness-plugin-pr-pilot
npm install -g agent-awareness-plugin-actions-watcher
npm install -g agent-awareness-plugin-energy-curve
npm install -g agent-awareness-plugin-quota
npm install -g agent-awareness-plugin-system
npm install -g agent-awareness-plugin-weather
```

The agent-awareness loader auto-discovers `agent-awareness-plugin-*` packages from both global and local `node_modules/`.

## Configuration

Plugin configs live in `plugins.d/` directories, searched in order:

1. `~/.claude-rig/rigs/<rig>/agent-awareness/plugins.d/` (per-rig)
2. `~/.config/agent-awareness/plugins.d/` (global)

Example: `~/.config/agent-awareness/plugins.d/actions-watcher.json`

```json
{
  "owner": "your-github-username",
  "maxAgeDays": 14
}
```

See each plugin's README for available config options.

## Multi-agent coordination

All plugins use the agent-awareness claims system to prevent duplicate reporting across concurrent sessions. When multiple Claude Code sessions are running, each event (repo activity, alert, workflow failure) is claimed by one session — the rest silently skip it.

## Creating a new plugin

See the [agent-awareness provider guide](https://github.com/edimuj/agent-awareness/blob/main/docs/creating-a-provider.md) for the plugin interface. Each plugin should:

1. Have its own directory with `package.json` and `src/index.ts`
2. Have a root `index.ts` that re-exports: `export { default } from './src/index.ts';`
3. Export a default object conforming to `AwarenessPlugin<TState>`
4. Include a `README.md` with config documentation
5. Ship compiled `.js` for npm (Node 24+ blocks TypeScript in `node_modules/`)
6. Use `context.claims.tryClaim()` for multi-agent safety

### Build & publish

```bash
npm run build          # compile all plugins
cd <plugin> && npm publish
```

## License

MIT
