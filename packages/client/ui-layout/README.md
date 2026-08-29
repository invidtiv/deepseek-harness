# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

Shell plugin: five-column AppFrame (drag handles and concession chain) plus the `ctx.layout` panel-geometry service; it registers into the runtime-owned `root` slot and declares `sidebar`, `conversation`, `explorer`, `details`, `fileViewer`, and `conversation.empty`. The sidebar resize boundary is an invisible hit strip, while the other boundaries retain their floating pill; during concession the file viewer concedes before details, and an open explorer shrinks only after both right panels are dead. A closed sidebar retains a 56px control rail, a closed explorer retains a 44px rail (its occupant stays mounted), and details closes to zero width while staying mounted. The package also seats the theme presenter: it consumes resolved `ctx.theme` snapshots and projects them onto the document (`html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background). Measuring after palette and token application keeps the rendered background as the single color authority; disposing the presenter removes its metadata node with its other global writes.

AppFrame always mounts the conversation, explorer, and details columns; a connected Session renders through `SessionProvider`. The transient layout store starts the sidebar at its default width and every right column closed, and it never reads or writes `localStorage`. Hero and other unselected states also derive a zero rendered details width without changing that stored preference. AppFrame retains the last non-blank Session id across those states: the first Session remains closed, an explicit details action opens the contract default width, returning to the same Session restores its unchanged width, and selecting a different Session closes details before paint. The conversation owner share is empty; the sidebar and explorer owner shares carry `collapsed` (from the resolved rail, so solver auto-collapse renders rail UI too) plus `width`; registrants obtain business data from standard hooks and actions from their own inject faces.

The `/client` exports are the plugin body (`apply`/`inject`), `LayoutController`, `toggleExplorer()` on `ILayout`, and the five owner-share interfaces. AppFrame, the panel store, and the concession solver remain package-internal.

## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Panel geometry is transient** — reload restores the sidebar default and details closed; switching between distinct Session ids also closes details and forgets its dragged width, while unselected surfaces render details at zero width without modifying geometry.
- **Concession-chain auto-close derives a zero width without touching the preferred width** — the panel restores itself when the window widens; consumers must not read the stored details width as the rendered truth.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.
