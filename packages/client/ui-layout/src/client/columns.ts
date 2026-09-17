/**
 * Pure concession-chain column solver for the five-column AppFrame
 * (sidebar | center | explorer | fileViewer | rightbar). Chain order is fixed
 * by contract: keep center >= CENTER_MIN by shrinking the rightbar toward its
 * minimum first (it is the outermost and its occupant keeps drawing even at a
 * reduced track), then dropping the rightbar's track entirely (derived zero
 * width — the occupant hangs over the centre from the frame edge), then
 * shrinking the file viewer toward its minimum, then auto-closing it, then
 * letting an open explorer concede toward its minimum and finally
 * auto-collapse (derived zero and rail widths — preferred width preferences
 * are never rewritten, so widening the window restores them). The rails never
 * concede: a closed explorer renders at its fixed control-rail width and a
 * closed sidebar at the caller-supplied collapsed track, and center absorbs any
 * remaining deficit as the last resort. Inputs are the layout store's plain
 * width preferences (0 = closed;
 * the rightbar input is its desired track width, 0 = the occupant asked for no
 * track or is hidden). A closed right panel resolves to zero width while
 * closed side columns resolve to their rail. The SIDEBAR_AUTO_COLLAPSE
 * breakpoint is consumed by AppFrame, which decides the effective sidebar
 * preference before solving; the solver itself stays breakpoint-free.
 */

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns {
  sidebar: number
  center: number
  explorer: number
  fileViewer: number
  rightbar: number
}

// Contract-frozen geometry: the concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Explorer drag clamp floor. */
export const EXPLORER_MIN = 260
/** Explorer drag clamp ceiling. */
export const EXPLORER_MAX = 520
/** Explorer width before any user drag. */
export const EXPLORER_DEFAULT = 300
/** Closed-explorer rail: one pinned expand tab on the frame's right edge. */
export const EXPLORER_COLLAPSED = 44
/** File-viewer drag clamp floor. */
export const FILE_VIEWER_MIN = 420
/** File-viewer drag clamp ceiling. */
export const FILE_VIEWER_MAX = 1600
/** File-viewer width before any user drag (~45% of a 1600px window). */
export const FILE_VIEWER_DEFAULT = 720
/** Right panel (rightbar) drag clamp floor. */
export const RIGHTBAR_MIN = 300
/** Maximum right panel width as a fraction of the frame. */
export const RIGHTBAR_MAX_RATIO = 0.7
/** First-open right panel preference as a fraction of the frame. */
export const RIGHTBAR_DEFAULT_RATIO = 0.45

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the five column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param explorer - explorer width preference in px (0 = closed).
 * @param fileViewer - file-viewer width preference in px (0 = closed).
 * @param rightbar - right panel's desired track width in px (0 = no track).
 * @param collapsedWidth - track width of the closed sidebar; the default keeps
 *   the icon rail, 0 hides the column entirely (macOS desktop and the Windows
 *   caption row).
 * @returns resolved widths; a closed right panel is 0 (its column never
 *   unmounts), while a closed side column keeps its compact rail. The rightbar
 *   resolves to its desired track only while the chain can afford it; without
 *   a track its occupant hangs over the center from the frame edge.
 */
export function computeColumns(
  viewport: number,
  sidebar: number,
  explorer: number,
  fileViewer: number,
  rightbar: number,
  collapsedWidth = SIDEBAR_COLLAPSED,
): Columns {
  // Side rails are fixed at the resolved preference (or the rail) — they never concede.
  const s = sidebar === 0 ? collapsedWidth : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const rail = EXPLORER_COLLAPSED
  const e0 = explorer === 0 ? rail : clampWidth(explorer, EXPLORER_MIN, EXPLORER_MAX)
  const f0 = fileViewer === 0 ? 0 : clampWidth(fileViewer, FILE_VIEWER_MIN, FILE_VIEWER_MAX)
  const r0 = rightbar === 0 ? 0 : clampWidth(rightbar, RIGHTBAR_MIN, Math.max(RIGHTBAR_MIN, viewport * RIGHTBAR_MAX_RATIO))

  // Step 1: everything fits at preferred widths.
  if (s + e0 + f0 + r0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - e0 - f0 - r0, explorer: e0, fileViewer: f0, rightbar: r0 }
  }

  // Step 2: shrink the rightbar's track toward its minimum — it concedes
  // first because its occupant keeps drawing while the track narrows.
  if (r0 > 0) {
    const room = viewport - s - e0 - f0 - CENTER_MIN
    if (room >= RIGHTBAR_MIN) {
      const r = Math.min(r0, room)
      return { sidebar: s, center: viewport - s - e0 - f0 - r, explorer: e0, fileViewer: f0, rightbar: r }
    }
  }

  // Step 3: drop the rightbar's track — the occupant hangs over the center.
  if (s + e0 + f0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - e0 - f0, explorer: e0, fileViewer: f0, rightbar: 0 }
  }

  // Step 4: shrink the file viewer toward its minimum, keeping the center
  // floor (the rightbar's track is already gone, so the panel rides over
  // whatever the narrower columns leave).
  let f = f0
  const budget = viewport - s - e0 - CENTER_MIN
  if (f > FILE_VIEWER_MIN && f > budget) f = Math.max(budget, FILE_VIEWER_MIN)
  if (s + e0 + f + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - e0 - f, explorer: e0, fileViewer: f, rightbar: 0 }
  }

  // Step 5: auto-close the file viewer (derived zero width).
  f = 0
  if (s + e0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - e0, explorer: e0, fileViewer: f, rightbar: 0 }
  }

  // Step 6: only an open explorer concedes next — shrink just far enough to
  // restore the center floor (clamped into its contract range), then
  // auto-collapse to the rail — before center takes the last deficit (center
  // may drop below CENTER_MIN, but never below zero).
  let e = e0
  if (explorer !== 0 && s + e + CENTER_MIN > viewport) {
    const restored = viewport - s - CENTER_MIN
    if (e > EXPLORER_MIN && restored < e) {
      e = Math.max(EXPLORER_MIN, restored)
    }
    if (s + e + CENTER_MIN > viewport) e = rail
  }
  return { sidebar: s, center: Math.max(0, viewport - s - e), explorer: e, fileViewer: 0, rightbar: 0 }
}
