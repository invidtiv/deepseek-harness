# Agent Note: In-app file viewer drawer with a Markdown reader mode

Status: implemented

English | [中文](2026-08-27-file-viewer-drawer.zh.md)

## Problem

Clicking any file reference in the web GUI — an inline-code mention in chat, a produced-files chip, or a tool row's file link — handed the path to the Host's native opener (`session.openWorkspacePath`), which delegates to the OS default application. The browser then lost the context: the file opened outside the harness, left no history, and on machines without a registered handler for the extension did nothing useful at all.

The GUI had no way to show a text file inside the page. Code and Markdown are this repository's dominant artifact types, so a viewer that can render both — source for code, a rendered document view for Markdown — covers most reads without leaving the session.

## Decision

A new client plugin package, `@deepseek-ai/dsh-client-ui-file-viewer`, owns the right-side file viewer drawer; the layout (`ui-layout`) owns its column.

- **Host RPC `workspace.readFile`** (a Workspace Controller Remote verb) reads one text file bounded to 2 MiB and refuses binary content via a NUL-byte heuristic, returning `{ path, content, size, truncated, binary }`. A missing path fails with `file-not-found`; a directory or unreadable target with `file-unreadable`. The read cap is enforced by reading at most one byte past it, so truncation is proven without loading an unbounded file.
- **`ui-layout` gains the `fileViewer` column** after `details` (fourth at introduction; the later [explorer column](2026-08-27-collapsible-explorer-column-and-host-list-files.md) sits between conversation and details and leaves this ordering intact). Both right panels are independent; the concession solver shrinks the file viewer toward its minimum first (it is the outermost and typically widest), then details, then auto-closes the file viewer before details. The column stays mounted at zero width when closed.
- **`ctx.fileViewer` exposes `open(path)`/`close()`.** Opening writes a `loading` transition, opens the column, and folds the result into `ready`/`error`; a request-sequence guard drops stale reads from rapid re-opens or closes during flight. One root-scoped store holds the single active file and the drawer's render mode.
- **Click routing stays optional-service.** `ui-chat` reads `ctx.get('fileViewer')` lazily: a file path opens in the drawer when the plugin is composed in, while directories and compositions without the package keep the OS opener. Composing the package out restores the old behavior with zero caller edits.
- **Markdown reader mode.** A ready `.md`/`.mdx` document offers a rendered/source toggle (`role="switch"`) in the drawer header. Rendered draws ui-primitives' settled GFM+KaTeX pipeline (`MarkdownText`, the same renderer as chat messages, including fence copy buttons); source shows the plain line-numbered highlighted view. The mode resets to source whenever another file opens or the drawer closes; re-opening the same Markdown path restores the prior mode. Binary refusals never offer the toggle. A document truncated at the read cap may end mid-block in the rendered view; the metadata row keeps the truncation flag visible there.
- **Highlighting reuses ui-primitives' shiki highlighter** (`highlightLines`, re-exported publicly) so token colors stay on the `--shiki-*` theme tokens.

## Alternatives considered

**Render Markdown by extending the drawer's own highlighter instead of reusing `MarkdownText`.** A lighter custom pass could skip KaTeX and the streaming machinery, but it would fork GFM behavior between chat and the viewer and duplicate reference/footnote handling that ui-primitives already owns. Reusing the settled pipeline costs bundling nothing extra (the dynamic module table already ships the primitives row) and keeps one Markdown behavior.

**Put the viewer inside the existing details panel as a tab rather than a separate column.** Details is per-session inspection state for selected calls; mixing raw file viewing into it would couple two different lifetimes and force the solver's single details width onto both. A separate column keeps both panels independent at their own widths.

**Make `openFile` callers choose the destination.** Requiring every producer of file links to decide "viewer or OS" would spread the policy across packages. Routing once inside `ui-chat`'s injected face — with the lazy optional-service lookup — keeps the fallback automatic and composition-driven.

## Consequences

Reading arbitrary host files through a Workspace Remote verb enlarges the reachable data surface, but the request rides the same browser-trust fence as every other `/api` call and returns data to the page instead of handing paths outward; the 2 MiB cap and binary refusal bound what reaches the DOM. Truncated near-cap files still render every line — virtualization is deferred until a real usage shape needs it. The drawer is a single global surface: opening a file from one session replaces the view shown from another.

## Testing

Coverage lives with the package: store transitions and mode persistence, controller request-guard and capability flows, component toggle/render/source switching, apply wiring, disposal, the shared Markdown predicate, plus layout column tests updated to four tracks and connection/runtime fixture clients wired for `workspace.readFile`.
