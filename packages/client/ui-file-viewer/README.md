---
description: "Right-side file-viewer drawer for the Web GUI: the ctx.fileViewer face, bounded highlighted reads, and a Markdown reader mode, for users and maintainers of in-app file viewing."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-file-viewer

English | [中文](README.zh.md)

## Summary

Right-side file-viewer drawer owner. It provides the `ctx.fileViewer` face (`open`/`close`) and registers the drawer into the layout-owned `fileViewer` column, so clicking a file reference — an inline-code mention, a produced-files chip, or a tool row's file link — opens the file's contents in a resizable right-side panel instead of the OS default application. The browser half is the whole plugin; the Node half is an empty loader entry.

## Table of Contents

- [Controller face](#controller-face)
- [Drawer rendering](#drawer-rendering)
- [Interception ownership](#interception-ownership)
- [Trust fence](#trust-fence)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="controller-face"></a>
## Controller face

`FileViewerController` is the cross-plugin face: `open` writes a `loading` transition, opens the layout column, then folds the Host `readFile` result into `ready`/`error`. A request sequence guard drops a stale read after a rapid re-open or a close during flight. The Host read is bounded (a too-large file returns a truncated prefix, a non-text file returns `binary`), so the drawer never loads an unbounded file into the DOM or renders garbled text.

-----

<a id="drawer-rendering"></a>
## Drawer rendering

`FileViewer` renders the drawer's chrome — basename plus full path header with a close button, a metadata row (language, line count, size, truncation), and a scrollable body. The body reuses ui-primitives' shiki per-line highlighter (the read card's path), so a line-numbered gutter sits beside token-colored source, an unknown or not-yet-loaded language renders plain monospace, and the whole surface keeps native text selection. An empty active file (drawer closed) renders nothing while the column stays mounted at zero width.

A `.md`/`.mdx` document additionally offers the Markdown reader: the header grows a rendered/source toggle (`role="switch"`) that draws the document through ui-primitives' settled GFM+KaTeX pipeline (`MarkdownText`, the chat-message renderer, so fence copy buttons, safe links, and math come along), while `source` shows the plain highlighted source. The mode resets to source whenever a different file opens or the drawer closes; re-opening the same Markdown path restores whichever mode it was left in. Binary refusals never offer the toggle.

-----

<a id="interception-ownership"></a>
## Interception ownership

Interception is the caller's choice, not this package's: [ui-chat](../ui-chat/README.md) resolves a click's path against the session cwd and, when `ctx.get('fileViewer')` resolves, routes it to `open`; otherwise it falls back to the Host's native opener (`session.openWorkspacePath`). Composing this package out therefore restores the previous open-with-default-application behavior for every file link with zero caller edits. The directory case (`Show in folder`) is not a file read and keeps the Host opener regardless.

-----

<a id="trust-fence"></a>
## Trust fence

`readFile` is an ordinary workspace Remote verb, not a privileged endpoint: it rides the same browser-trust fence every `/api` request passes (loopback, a deployment-derived LAN literal, or a declared trusted host), and the drawer shows its error state for any refused request. Contract: the [slot system standard](../../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md).

-----

<a id="model-experience"></a>
## Model Experience

None, as the drawer renders files the browser already opened; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Very large files render every line into the DOM.** The Host read is capped at 2 MiB, but a truncated prefix near that bound is still many thousands of rows; virtualization (or a client line cap) is deferred until a real usage shape needs it.
- **Binary refusal is a NUL-byte heuristic.** A UTF-16 or other NUL-free non-UTF-8 file may decode as replacement characters rather than being refused; a stricter detection pass is deferred.
- **The drawer is a single global surface.** Opening a file in one session replaces the file shown from another; per-session active-file memory is deferred.
- **Rendered Markdown truncated at the read cap may cut the document mid-block.** The GFM pipeline renders what it receives, so a 2 MiB-prefix boundary inside a fenced block can close it implicitly; the truncation badge in the source view is the authoritative signal, and the reader view keeps that flag in the metadata row.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

No runtime invariant companion is published; the slot, dictionary, store, and service registrations are effect-owned with disposal proven by the plugin specs, and the package owns no mutable state outside those fibers.

</details>
