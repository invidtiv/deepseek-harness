# Agent Note: collapsible explorer column and workspace.listFiles

Status: implemented

English | [中文](2026-08-27-collapsible-explorer-column-and-host-list-files.zh.md)

## Problem

The web GUI had no way to browse the project's files: file references opened through the viewer or the OS opener, but discovering a path required asking the agent to print one. The Workspace Controller already carries the read face for the viewer (`readFile`), yet nothing composed a standing navigator surface, and the layout shell's right side had only two occupant columns (details, fileViewer).

## Decision

Two moves, one per plane:

**Host API.** `workspace.listFiles({path?})` joins `workspace.readFile` on the Workspace Controller's Remote namespace: one mixed directory level (`FileListingEntry {name, path, kind, hidden}`), name-ordered by the Host, bounded at 1000 entries with `truncated`, symlink kinds resolved via stat-probe at listing time. An absent path lists the process cwd — the default project root — so the client never needs an absolute starting point.

**Seam classing.** `listFiles` is an ordinary Workspace Remote verb beside `readFile` — behind the browser-trust fence every `/api` request passes — deliberately bypassing the directoryPicker capability seam. The picker resolves to its native provider on Windows deployments; gating browsing behind a seam that resolves to "native" there would have shipped a navigator that could not open itself on the very platform this session runs on.

**Client composition.** ui-layout grows a fifth child column between conversation and details with its own rail contract (44px closed width, occupant stays mounted, owner props derived from the solved track), and solver step 3 concedes an open explorer toward the center floor only after both right panels are dead — then auto-collapses to the rail before letting the center fall below floor in the last resort. The new ui-file-explorer package registers lazily against this contract: one fetch per expanded level, cache-per-path keyed by the echoed absolute response path ('' is the root request sentinel), per-level error + retry, and open routing shared with ui-chat's viewer-preferring fallback.

Default column state is CLOSED (preference 0 ⇄ default 300px) to keep the assembled boot output byte-stable and the fold opt-in.

## Consequences

- `SlotMap` gains the `explorer` entry and AppFrame renders four tracks; `ILayout.toggleExplorer()` is the single expand/collapse face; drawer consumers were untouched.
- The permanent explorer rail costs every wide viewport its 44px even while preference-closed; accepted as the price of a discoverable affordance (the sidebar already paid it).
- Client display sort (directories first) must keep agreeing with the Host's intra-partition locale order; the truncation head window stays honest because both ends sort the same strings.
- Fixture doubles across connection/test-runtime/fake-api implement `listFiles`; any future consumer stub update trips tsc, which is the intended tripwire.

## Alternatives considered

- **Gate browsing behind directoryPicker** — rejected above: platform-dependent brokenness for the primary deployment.
- **Tree served whole from the Host** (one recursive snapshot) — rejected: unbounded depth/size on real projects, no incremental discovery, and re-fetch storms on change; level-lazy keeps cost proportional to what the user opens.
- **Reusing the settings-plugins tree component** — rejected: different data source (inventory rows vs filesystem levels), different interaction target (toggle vs open-file), and the folder analogy would couple two unrelated surfaces.
