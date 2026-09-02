import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN, clampWidth, computeColumns,
  DETAILS_DEFAULT, DETAILS_MIN, EXPLORER_COLLAPSED, EXPLORER_DEFAULT, EXPLORER_MAX, EXPLORER_MIN,
  FILE_VIEWER_DEFAULT, FILE_VIEWER_MIN,
  SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// Numeric preference form (0 = closed); helpers keep the scenario names readable.
const open = (width: number) => width
const closed = (_width: number) => 0

/** Compact four-argument runner: sidebar / details / fileViewer / explorer preferences. */
function solve(viewport: number, prefs: [number, number, number, number]) {
  return computeColumns(viewport, open(prefs[0]), open(prefs[1]), open(prefs[2]), open(prefs[3]))
}

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('computeColumns', () => {
  it('step 1: everything fits at preferred widths', () => {
    const cols = computeColumns(
      1920,
      open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(cols).toEqual({
      sidebar: 280,
      // The closed explorer's rail is part of the frame like the sidebar rail.
      center: 1920 - 280 - EXPLORER_COLLAPSED - 360,
      explorer: EXPLORER_COLLAPSED,
      details: 360,
      fileViewer: 0,
    })
  })

  it('closed side columns keep their rails while closed right panels contribute zero width', () => {
    const cols = solve(1920, [closed(300), closed(360), closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT)])
    expect(cols).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: 1920 - SIDEBAR_COLLAPSED - EXPLORER_COLLAPSED,
      explorer: EXPLORER_COLLAPSED,
      details: 0,
      fileViewer: 0,
    })
  })

  it('preferences beyond the clamp range are clamped before solving', () => {
    const cols = solve(9999, [open(9999), open(1), open(1), open(EXPLORER_MAX)])
    expect(cols.sidebar).toBe(420)
    expect(cols.details).toBe(300)
    expect(cols.fileViewer).toBe(FILE_VIEWER_MIN)
    expect(cols.explorer).toBe(EXPLORER_MAX)
    const narrow = solve(9999, [open(1), open(DETAILS_DEFAULT), closed(FILE_VIEWER_DEFAULT), open(EXPLORER_DEFAULT)])
    expect(narrow.sidebar).toBe(SIDEBAR_MIN)
  })

  it('step 2: details shrinks first, center pinned at min', () => {
    // 280 + 44 + 360 + 640 = 1324 > 1250; details concedes to 1250-280-44-640 = 286 —
    // below its floor, so the auto-close rule takes over instead.
    const cols = computeColumns(
      1250,
      open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(cols.details).toBe(0)
    expect(cols.center).toBe(1250 - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED)
  })

  it('boundary: exactly at the step-1/step-2 seam (one pixel starves an open panel)', () => {
    const seam = SIDEBAR_DEFAULT + EXPLORER_COLLAPSED + DETAILS_DEFAULT + CENTER_MIN
    const cols = computeColumns(
      seam,
      open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(cols).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: CENTER_MIN,
      explorer: EXPLORER_COLLAPSED,
      details: DETAILS_DEFAULT,
      fileViewer: 0,
    })
    const one = computeColumns(
      seam - 1,
      open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(one.explorer).toBe(EXPLORER_COLLAPSED)
    expect(one.fileViewer).toBe(0)
    expect(one.details).toBe(DETAILS_DEFAULT - 1)
    expect(one.center).toBe(CENTER_MIN)
  })

  it('step 3: details auto-closes when its min still starves center — sidebar holds its preference', () => {
    // 280 + 44 + 300 + 640 = 1264 > 1250 → details 0; center = 1250-280-44 = 926.
    const cols = computeColumns(
      1250,
      open(SIDEBAR_DEFAULT), open(DETAILS_MIN),
      closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(cols).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: 1250 - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED,
      explorer: EXPLORER_COLLAPSED,
      details: 0,
      fileViewer: 0,
    })
  })

  it('the rails never concede: center absorbs the deficit below CENTER_MIN', () => {
    // 700 < 280+44+640: both rails hold, center takes 376.
    const cols = computeColumns(
      700,
      open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(cols).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: 700 - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED,
      explorer: EXPLORER_COLLAPSED,
      details: 0,
      fileViewer: 0,
    })
  })

  it('sidebar-closed narrow window: details concedes then auto-closes', () => {
    const fitsViewport = SIDEBAR_COLLAPSED + EXPLORER_COLLAPSED + DETAILS_MIN + CENTER_MIN
    const fits = computeColumns(
      fitsViewport,
      closed(300), open(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(fits).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: CENTER_MIN,
      explorer: EXPLORER_COLLAPSED,
      details: DETAILS_MIN,
      fileViewer: 0,
    })
    const starved = computeColumns(
      fitsViewport - 1,
      closed(300), open(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(starved).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: DETAILS_MIN + CENTER_MIN - 1,
      explorer: EXPLORER_COLLAPSED,
      details: 0,
      fileViewer: 0,
    })
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    const squeezed = computeColumns(
      1000,
      open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(squeezed.details).toBe(0)
    const restored = computeColumns(
      1920,
      open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(restored.details).toBe(DETAILS_DEFAULT)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — file viewer', () => {
  it('step 1: an open file viewer fits at its preferred width', () => {
    const cols = computeColumns(
      1920,
      open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT),
      open(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(cols).toEqual({
      sidebar: 280,
      center: 1920 - 280 - EXPLORER_COLLAPSED - FILE_VIEWER_DEFAULT,
      explorer: EXPLORER_COLLAPSED,
      details: 0,
      fileViewer: FILE_VIEWER_DEFAULT,
    })
  })

  it('the file viewer concedes before details (details keeps its width)', () => {
    // budget = 1820 - 280 - 44 - 640 = 856, between details+fileViewer.min
    // (720) and details+fileViewer.default (1080): only the file viewer shrinks.
    const cols = computeColumns(
      1820,
      open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT),
      open(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(cols.details).toBe(DETAILS_DEFAULT)
    expect(cols.fileViewer).toBe(856 - DETAILS_DEFAULT)
    expect(cols.center).toBe(CENTER_MIN)
  })

  it('the file viewer auto-closes before details gives up its minimum', () => {
    // budget = 1420 - 280 - 44 - 640 = 456 < details.min + fileViewer.min
    // (720): the file viewer closes while details keeps its minimum.
    const cols = computeColumns(
      1420,
      open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT),
      open(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT),
    )
    expect(cols.fileViewer).toBe(0)
    expect(cols.details).toBe(DETAILS_MIN)
    expect(cols.center).toBe(1420 - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED - DETAILS_MIN)
  })
})

describe('computeColumns — explorer', () => {
  it('step 1: an open explorer fits alongside the right panels at preferred widths', () => {
    const viewport = SIDEBAR_DEFAULT + EXPLORER_DEFAULT + DETAILS_DEFAULT + FILE_VIEWER_DEFAULT + CENTER_MIN
    const cols = computeColumns(
      viewport,
      open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT),
      open(FILE_VIEWER_DEFAULT), open(EXPLORER_DEFAULT),
    )
    expect(cols).toEqual({
      sidebar: 280,
      center: CENTER_MIN,
      explorer: EXPLORER_DEFAULT,
      details: DETAILS_DEFAULT,
      fileViewer: FILE_VIEWER_DEFAULT,
    })
  })

  it('an open explorer does not concede while any right panel is alive', () => {
    // Both right panels die inside fitRightPanels; the explorer keeps its
    // clamped preference until step 3 runs.
    const cols = computeColumns(
      1450,
      open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT),
      open(FILE_VIEWER_DEFAULT), open(500),
    )
    expect(cols.details).toBe(0)
    expect(cols.fileViewer).toBe(0)
    expect(cols.explorer).toBe(500)
    expect(cols.center).toBe(1450 - SIDEBAR_DEFAULT - 500)
  })

  it('an open explorer shrinks only far enough to restore the center floor', () => {
    // Surplus beyond the restored floor: the explorer drops from 500 to 300
    // and the center recovers exactly to CENTER_MIN.
    const cols = computeColumns(
      1220,
      open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), open(500),
    )
    expect(cols.explorer).toBe(300)
    expect(cols.center).toBe(CENTER_MIN)
  })

  it('the shrink reaches EXPLORER_MIN exactly on the fit seam', () => {
    const viewport = SIDEBAR_DEFAULT + EXPLORER_MIN + CENTER_MIN
    const cols = computeColumns(
      viewport,
      open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), open(500),
    )
    expect(cols.explorer).toBe(EXPLORER_MIN)
    expect(cols.center).toBe(CENTER_MIN)
  })

  it('just below that seam an open explorer auto-collapses to its rail instead', () => {
    const below = SIDEBAR_DEFAULT + EXPLORER_MIN + CENTER_MIN - 1
    const cols = computeColumns(
      below,
      open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), open(500),
    )
    expect(cols.explorer).toBe(EXPLORER_COLLAPSED)
    expect(cols.center).toBe(below - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED)
  })

  it('the collapsed resolution never reads as a concession target', () => {
    // Below the auto-collapse outcome's own threshold nothing else gives:
    // the rails hold and center drops under CENTER_MIN as the final fallback.
    const cols = computeColumns(
      900,
      open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), open(500),
    )
    expect(cols.explorer).toBe(EXPLORER_COLLAPSED)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.center).toBe(900 - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED)
  })

  it('recovery is pure across the whole chain: re-widening restores the explorer preference', () => {
    const squeezed = computeColumns(
      1050,
      open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), open(500),
    )
    expect(squeezed.explorer).toBe(EXPLORER_COLLAPSED)
    const restored = computeColumns(
      2000,
      open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT),
      closed(FILE_VIEWER_DEFAULT), open(500),
    )
    expect(restored.explorer).toBe(500)
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('side rails closed and viewport below CENTER_MIN: everything closes or rides its rail, center takes the rest', () => {
    // Reaches the auto-close with compact rails on both sides.
    const cols = solve(500, [closed(300), open(DETAILS_DEFAULT), closed(FILE_VIEWER_DEFAULT), closed(EXPLORER_DEFAULT)])
    expect(cols).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: 500 - SIDEBAR_COLLAPSED - EXPLORER_COLLAPSED,
      explorer: EXPLORER_COLLAPSED,
      details: 0,
      fileViewer: 0,
    })
  })
})
