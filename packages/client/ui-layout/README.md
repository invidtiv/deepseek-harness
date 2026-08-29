---
description: "Shell layout for the Web GUI: the five-column AppFrame with drag handles, concession behavior, the panel-geometry service, and theme presentation; for users and maintainers of the window chrome."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-layout

English | [中文](README.zh.md)

## Summary

This package provides the shell layout of the Web GUI: a five-column AppFrame with resizable sidebar, explorer, details, and file-viewer panels, a concession chain that shrinks the file viewer first, then details, then auto-closes both — an open explorer concedes only after both right panels are gone — and the `ctx.layout` panel-geometry service other plugins call to open or close the right panels and toggle the explorer. It also seats the theme presenter, which projects the resolved color scheme, alias tokens, content font size, and `theme-color` metadata onto the document. Choose it for the standard window chrome; panel geometry is transient and resets on reload.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin at the root slot; it then renders the app frame around whatever occupies the sidebar, explorer, conversation, details, and file-viewer columns. Users resize the sidebar by dragging its invisible hit strip and the other panels by dragging their floating pills; when the window narrows, the file viewer shrinks first, then details, then both auto-close, and only afterwards does an open explorer shrink. A closed sidebar retains a 56px control rail, a closed explorer retains a 44px rail with its occupant still mounted, and the details and file-viewer panels close to zero width while staying mounted.

### Theme presentation

The presenter consumes resolved theme snapshots and projects them onto the document: `html { color-scheme }` for native UA chrome, `body[data-ds-dark-theme]` from the active color scheme, the theme's alias tokens and `--dsh-content-font-size` as inline variables on body, and one owned `<meta name="theme-color">` whose content follows the computed body background. Disposing the presenter removes its metadata node with its other global writes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `register()` call contributes `AppFrame` into the runtime's built-in `'root'` slot and, in the same breath, declares the six child slots (`sidebar`, `conversation`, `explorer`, `details`, `fileViewer`, `shell.overlay`), seats the layout store (panel geometry), and wires the `ctx.layout` panel-action service. The transient layout store starts the sidebar at its default width and every right column closed, and never reads or writes `localStorage`. AppFrame always mounts the conversation, explorer, and details columns, and the file-viewer drawer keeps its subtree mounted at zero width; a connected Session renders through `SessionProvider`. It projects the selected Session title over the build-configured product title or the localized `common.brand.localBuild` fallback, so locale revisions update document metadata with the root entry. The sidebar and explorer slots receive the frame's live column state (`collapsed` from the resolved rail, so solver auto-collapse renders rail UI too, plus `width`); the theme presenter is a second effect: pure DOM writes from resolved snapshots — initial state through the getter once, then event-driven only, with no React path. It applies palette, font-size, and token variables before measuring the rendered background as the single color authority.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the layout surface is not enough. They move from the frame to the columns it renders and the theme it presents.

- [ui-sidebar](../ui-sidebar/README.md) — occupies the `sidebar` column and its seats.
- [ui-file-explorer](../ui-file-explorer/README.md) — occupies the `explorer` column.
- [ui-conversation](../ui-conversation/README.md) — occupies the `conversation` and `details` columns.
- [ui-file-viewer](../ui-file-viewer/README.md) — occupies the `fileViewer` column.
- [ui-theme](../ui-theme/README.md) — the theme seam whose resolved snapshots the presenter consumes.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the layout shell manages browser viewing state; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current layout behavior. They are current package constraints, not a general window-manager comparison or a task backlog.

- **Panel geometry is transient** — reload restores the sidebar default and the right columns closed; switching between distinct Session ids also closes details and forgets its dragged width, while unselected surfaces render details at zero width without modifying geometry.
- **Concession-chain auto-close derives a zero width without touching the preferred width** — the panel restores itself when the window widens; consumers must not read the stored details width as the rendered truth.
- **No scroll anchoring during squeeze reflow** — layout changes may move the reader's viewport.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
