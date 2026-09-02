/**
 * Pure concession-chain column solver for the five-column AppFrame
 * (sidebar | center | explorer | details | fileViewer). Chain order is fixed
 * by contract: keep center >= CENTER_MIN by shrinking the file viewer toward
 * its minimum first (it is the outermost and typically widest right panel),
 * then details, then auto-closing the file viewer and finally details
 * (derived zero widths — preferred width preferences are never rewritten, so
 * widening the window restores them); only after both right panels are gone
 * does an open explorer concede toward its minimum and then auto-collapse.
 * The rails never concede: a closed sidebar and a closed explorer each render
 * at their fixed control-rail width, and center absorbs any remaining deficit
 * as the last resort. Inputs are the layout store's plain width preferences
 * (0 = closed); a closed right panel resolves to zero width while closed
 * side columns resolve to their rail. The SIDEBAR_AUTO_COLLAPSE breakpoint is
 * consumed by AppFrame, which decides the effective sidebar preference before
 * solving; the solver itself stays breakpoint-free.
 */

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns {
  sidebar: number
  center: number
  explorer: number
  details: number
  fileViewer: number
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
/** Details drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360
/** File-viewer drag clamp floor. */
export const FILE_VIEWER_MIN = 420
/** File-viewer drag clamp ceiling. */
export const FILE_VIEWER_MAX = 1600
/** File-viewer width before any user drag (~45% of a 1600px window). */
export const FILE_VIEWER_DEFAULT = 720

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
 * Fit the two right panels (details, fileViewer) into a `budget` of pixels,
 * conceding the file viewer toward its minimum first, then details, then
 * auto-closing the file viewer and finally details. Preferences are never
 * rewritten; the returned widths are the derived rendered values.
 * @param budget - pixels available for the two right panels after the left columns and center floor.
 * @param details - details width preference (0 = closed).
 * @param fileViewer - file-viewer width preference (0 = closed).
 * @returns the rendered details and fileViewer widths that fit the budget.
 */
function fitRightPanels(budget: number, details: number, fileViewer: number): { details: number; fileViewer: number } {
  let d = details
  let f = fileViewer
  if (d + f <= budget) return { details: d, fileViewer: f }
  // Concede the file viewer first.
  if (f > FILE_VIEWER_MIN) f = Math.max(f - (d + f - budget), FILE_VIEWER_MIN)
  if (d + f <= budget) return { details: d, fileViewer: f }
  // Then details.
  if (d > DETAILS_MIN) d = Math.max(d - (d + f - budget), DETAILS_MIN)
  if (d + f <= budget) return { details: d, fileViewer: f }
  // Auto-close the file viewer, then details (derived zero widths).
  f = 0
  if (d <= budget) return { details: d, fileViewer: f }
  d = 0
  return { details: d, fileViewer: f }
}

/**
 * Solve the five column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @param fileViewer - file-viewer width preference in px (0 = closed).
 * @param explorer - explorer width preference in px (0 = closed).
 * @returns resolved widths; a closed right panel is 0 (never unmounted), while a closed side column keeps its compact rail.
 */
export function computeColumns(viewport: number, sidebar: number, details: number, fileViewer: number, explorer: number): Columns {
  // Side rails are fixed at the resolved preference (or the rail) — they never concede.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const r = EXPLORER_COLLAPSED
  let e = explorer === 0 ? r : clampWidth(explorer, EXPLORER_MIN, EXPLORER_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)
  const f0 = fileViewer === 0 ? 0 : clampWidth(fileViewer, FILE_VIEWER_MIN, FILE_VIEWER_MAX)

  // Step 1: everything fits at preferred widths.
  if (s + e + d0 + f0 + CENTER_MIN <= viewport) {
    return { sidebar: s, center: viewport - s - e - d0 - f0, explorer: e, details: d0, fileViewer: f0 }
  }

  // Step 2: shrink the right panels toward their minima (file viewer first),
  // keeping center at or above CENTER_MIN; when even the minima cannot fit,
  // auto-close them and let the overflow flow into step 3.
  const budget = Math.max(0, viewport - s - e - CENTER_MIN)
  const fit = fitRightPanels(budget, d0, f0)
  const d = fit.details
  const f = fit.fileViewer

  // Step 3: only an open explorer concedes next — shrink just far enough to
  // restore the center floor (clamped into its contract range), then
  // auto-collapse to the rail — before center takes the last deficit (center
  // may drop below CENTER_MIN, but never below zero).
  if (explorer !== 0 && s + e + d + f + CENTER_MIN > viewport) {
    const restored = viewport - s - d - f - CENTER_MIN
    if (e > EXPLORER_MIN && restored < e) {
      e = Math.max(EXPLORER_MIN, restored)
    }
    if (s + e + d + f + CENTER_MIN > viewport) e = r
  }

  return { sidebar: s, center: Math.max(0, viewport - s - e - d - f), explorer: e, details: d, fileViewer: f }
}
