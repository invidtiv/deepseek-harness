# @deepseek-ai/dsh-client-ui-file-explorer

English | [中文](README.zh.md)

Collapsible right-hand file-explorer column owner. It registers the tree into the layout-owned `explorer` slot (`sidebar | conversation | explorer | details | fileViewer`), one Host listing per directory level: expanding a row fetches that level through the workspaces face's `listFiles`, collapses keep the cache for instant re-expansion, and file rows route through the same open contract as every other clickable file reference — the `ctx.fileViewer` drawer when composed in, the Host's native opener (`session.openWorkspacePath`) otherwise. The browser half is the whole plugin; the Node half is an empty loader entry.

Column geometry belongs to [ui-layout](../ui-layout/README.md): the plugin renders against `collapsed`/`width` owner props derived from the solved track. A closed column reduces to a 44px rail whose pinned folder tab re-expands on click (through `ILayout.toggleExplorer()`), and the expanded header's collapse tab requests the reverse. The component never unmounts, so level caches, expansion state, and the selected-file highlight survive fold/unfold within one page load.

`FileExplorerRoot` sorts each level client-side with directories before files (locale order inside each partition, agreeing with the Host's name ordering), renders hidden entries like any other row, and appends a truncation note to any level the Host bounded (the 1000-entry listing cap). Failures are per-level: an unreadable child shows its own inline retry while the rest of the tree keeps working, and a root failure offers the wide retry.

Mount warms the project root once even while collapsed, so first expansion serves cached rows instead of a loading flash.

`listFiles` is an ordinary workspace Remote verb, not a privileged endpoint: it rides the same browser-trust fence every `/api` request passes (loopback, a deployment-derived LAN literal, or a declared trusted host), and levels show their error states for any refused request. Contract: the [slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md).

## Model Experience

None, as the tree reads directory names the user browses visually; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **No keyboard tree navigation yet.** Rows are individual buttons reachable by tabbing, but arrow-key traversal and typeahead over the flat button list are deferred until the component owns real usage pressure.
- **Symlink labels resolve once at listing time** — the Host stat-probes each entry as it lists, so a link flipped after its level loaded keeps the stale kind until the level is refetched.
- **The selected-file highlight does not follow external opens** — clicking elsewhere (a chat mention) opens the viewer without updating this tree's selection.
