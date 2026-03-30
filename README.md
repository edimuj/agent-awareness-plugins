# agent-awareness-plugins

Community provider plugins for [agent-awareness](https://github.com/edimuj/agent-awareness).

Each subdirectory is a standalone plugin that can be symlinked into `~/.config/agent-awareness/plugins/`.

## Plugins

| Plugin | Description |
|--------|-------------|
| [github-watcher](./github-watcher/) | Monitors GitHub repos for new issues, PRs, and comments |
| [server-health](./server-health/) | Threshold-based server alerts with hysteresis and cooldown |
| [pr-pilot](./pr-pilot/) | Tracks outbound PRs, detects lifecycle events, frames agent actions |

## Installation

```bash
# Symlink individual plugins
ln -s /path/to/agent-awareness-plugins/github-watcher ~/.config/agent-awareness/plugins/github-watcher
```

## Creating a new plugin

See the [agent-awareness provider guide](https://github.com/edimuj/agent-awareness/blob/main/docs/creating-a-provider.md) for the plugin interface. Each plugin in this repo should:

1. Have its own directory with `package.json` and `src/index.ts`
2. Have a root `index.ts` that re-exports: `export { default } from './src/index.ts';`
3. Export a default object conforming to `AwarenessPlugin`
4. Include a `README.md` with config documentation
5. Be self-contained (no shared dependencies between plugins)

## License

MIT
