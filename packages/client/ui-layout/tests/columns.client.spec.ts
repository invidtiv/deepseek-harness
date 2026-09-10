import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN, clampWidth, computeColumns,
  EXPLORER_COLLAPSED, EXPLORER_DEFAULT, EXPLORER_MAX, EXPLORER_MIN,
  FILE_VIEWER_DEFAULT, FILE_VIEWER_MAX, FILE_VIEWER_MIN,
  RIGHTBAR_MAX_RATIO, RIGHTBAR_MIN,
  SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// Numeric preference form (0 = closed); helpers keep the scenario names readable.
const open = (width: number) => width
const closed = (_width: number) => 0

/** Compact five-argument runner: sidebar / explorer / fileViewer / rightbar preferences. */
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

describe('computeColumns — preferred widths', () => {
  it('step 1: everything fits at preferred widths', () => {
    const cols = computeColumns(
      2400,
      open(SIDEBAR_DEFAULT), open(EXPLORER_DEFAULT),
      open(FILE_VIEWER_DEFAULT), open(400),
    )
    expect(cols).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: 2400 - SIDEBAR_DEFAULT - EXPLORER_DEFAULT - FILE_VIEWER_DEFAULT - 400,
      explorer: EXPLORER_DEFAULT,
      fileViewer: FILE_VIEWER_DEFAULT,
      rightbar: 400,
    })
  })

  it('closed side columns keep their rails while closed right columns contribute zero width', () => {
    const cols = solve(1920, [closed(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), closed(400)])
    expect(cols).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: 1920 - SIDEBAR_COLLAPSED - EXPLORER_COLLAPSED,
      explorer: EXPLORER_COLLAPSED,
      fileViewer: 0,
      rightbar: 0,
    })
  })

  it('preferences beyond the clamp range are clamped before solving', () => {
    const high = solve(9999, [open(9999), open(9999), open(9999), open(9999)])
    expect(high.sidebar).toBe(SIDEBAR_MAX)
    expect(high.explorer).toBe(EXPLORER_MAX)
    expect(high.fileViewer).toBe(FILE_VIEWER_MAX)
    const low = solve(1920, [open(1), open(1), open(1), open(1)])
    expect(low).toEqual({
      sidebar: SIDEBAR_MIN,
      center: 1920 - SIDEBAR_MIN - EXPLORER_MIN - FILE_VIEWER_MIN - RIGHTBAR_MIN,
      explorer: EXPLORER_MIN,
      fileViewer: FILE_VIEWER_MIN,
      rightbar: RIGHTBAR_MIN,
    })
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    const squeezed = solve(1000, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), open(400)])
    expect(squeezed.rightbar).toBe(0)
    const restored = solve(1920, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), open(400)])
    expect(restored.rightbar).toBe(400)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — rightbar track', () => {
  it('step 2: the track shrinks toward its minimum before anything closes', () => {
    // Preferred 280+44+400+640 = 1364 exceeds the frame; the track takes the
    // remaining room above the center floor instead of dropping.
    const cols = solve(1300, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), open(400)])
    expect(cols).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: CENTER_MIN,
      explorer: EXPLORER_COLLAPSED,
      fileViewer: 0,
      rightbar: 336,
    })
  })

  it('boundary: one pixel below the preferred fit shrinks the track by exactly one', () => {
    const seam = SIDEBAR_DEFAULT + EXPLORER_COLLAPSED + 400 + CENTER_MIN
    const exact = solve(seam, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), open(400)])
    expect(exact.rightbar).toBe(400)
    expect(exact.center).toBe(CENTER_MIN)
    const one = solve(seam - 1, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), open(400)])
    expect(one.rightbar).toBe(399)
    expect(one.center).toBe(CENTER_MIN)
  })

  it('the track is capped at RIGHTBAR_MAX_RATIO of the frame', () => {
    const viewport = 3300
    const cols = solve(viewport, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), open(3000)])
    expect(cols.rightbar).toBe(Math.round(viewport * RIGHTBAR_MAX_RATIO))
    expect(cols.center).toBe(viewport - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED - cols.rightbar)
  })

  it('step 3: the track drops entirely once it cannot hold its minimum, leaving the occupant over the center', () => {
    // 280+44+640 = 964 fits, so nothing else concedes: the panel hangs over.
    const cols = solve(1200, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), open(400)])
    expect(cols).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: 1200 - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED,
      explorer: EXPLORER_COLLAPSED,
      fileViewer: 0,
      rightbar: 0,
    })
  })

  it('boundary: at the bare rails-plus-center width the track is already gone', () => {
    const cols = solve(
      SIDEBAR_DEFAULT + EXPLORER_COLLAPSED + CENTER_MIN,
      [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), open(400)],
    )
    expect(cols.rightbar).toBe(0)
    expect(cols.center).toBe(CENTER_MIN)
  })

  it('only an open right panel concedes: another panel is never the one dropped', () => {
    // The report arrives from the occupant; the frame never resizes it.
    const cols = solve(1920, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), closed(400)])
    expect(cols.rightbar).toBe(0)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — file viewer', () => {
  it('an open file viewer keeps its width while only the rightbar track is dropped', () => {
    const cols = solve(1800, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), open(FILE_VIEWER_DEFAULT), open(400)])
    expect(cols.fileViewer).toBe(FILE_VIEWER_DEFAULT)
    expect(cols.rightbar).toBe(0)
    expect(cols.center).toBe(1800 - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED - FILE_VIEWER_DEFAULT)
  })

  it('step 4: the file viewer concedes toward its minimum once the rightbar track is gone', () => {
    const cols = solve(1600, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), open(FILE_VIEWER_DEFAULT), open(400)])
    expect(cols.fileViewer).toBe(1600 - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED - CENTER_MIN)
    expect(cols.center).toBe(CENTER_MIN)
    expect(cols.rightbar).toBe(0)
  })

  it('boundary: the exact seam keeps the preferred width, one pixel less shrinks it', () => {
    const seam = SIDEBAR_DEFAULT + EXPLORER_COLLAPSED + FILE_VIEWER_DEFAULT + CENTER_MIN
    const exact = solve(seam, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), open(FILE_VIEWER_DEFAULT), open(400)])
    expect(exact.fileViewer).toBe(FILE_VIEWER_DEFAULT)
    expect(exact.rightbar).toBe(0)
    const one = solve(seam - 1, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), open(FILE_VIEWER_DEFAULT), open(400)])
    expect(one.fileViewer).toBe(FILE_VIEWER_DEFAULT - 1)
    expect(one.center).toBe(CENTER_MIN)
  })

  it('step 5: the file viewer auto-closes when its minimum still starves the center', () => {
    const cols = solve(1380, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), open(FILE_VIEWER_DEFAULT), open(400)])
    expect(cols.fileViewer).toBe(0)
    expect(cols.rightbar).toBe(0)
    expect(cols.center).toBe(1380 - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED)
  })

  it('a closed file viewer is never a concession target', () => {
    const cols = solve(964, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), open(400)])
    expect(cols.fileViewer).toBe(0)
    expect(cols.center).toBe(CENTER_MIN)
  })
})

describe('computeColumns — explorer', () => {
  it('step 1: an open explorer fits alongside the right columns at preferred widths', () => {
    const viewport = SIDEBAR_DEFAULT + EXPLORER_DEFAULT + FILE_VIEWER_DEFAULT + 400 + CENTER_MIN
    const cols = computeColumns(
      viewport,
      open(SIDEBAR_DEFAULT), open(EXPLORER_DEFAULT),
      open(FILE_VIEWER_DEFAULT), open(400),
    )
    expect(cols).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: CENTER_MIN,
      explorer: EXPLORER_DEFAULT,
      fileViewer: FILE_VIEWER_DEFAULT,
      rightbar: 400,
    })
  })

  it('an open explorer does not concede while the right columns still have room to give', () => {
    const cols = solve(1450, [open(SIDEBAR_DEFAULT), open(500), open(FILE_VIEWER_DEFAULT), open(400)])
    expect(cols.explorer).toBe(500)
    expect(cols.fileViewer).toBe(0)
    expect(cols.rightbar).toBe(0)
    expect(cols.center).toBe(1450 - SIDEBAR_DEFAULT - 500)
  })

  it('the explorer shrinks only far enough to restore the center floor', () => {
    const cols = solve(1220, [open(SIDEBAR_DEFAULT), open(500), closed(FILE_VIEWER_DEFAULT), closed(400)])
    expect(cols.explorer).toBe(300)
    expect(cols.center).toBe(CENTER_MIN)
  })

  it('the shrink reaches EXPLORER_MIN exactly on the fit seam', () => {
    const viewport = SIDEBAR_DEFAULT + EXPLORER_MIN + CENTER_MIN
    const cols = solve(viewport, [open(SIDEBAR_DEFAULT), open(500), closed(FILE_VIEWER_DEFAULT), closed(400)])
    expect(cols.explorer).toBe(EXPLORER_MIN)
    expect(cols.center).toBe(CENTER_MIN)
  })

  it('just below that seam an open explorer auto-collapses to its rail instead', () => {
    const below = SIDEBAR_DEFAULT + EXPLORER_MIN + CENTER_MIN - 1
    const cols = solve(below, [open(SIDEBAR_DEFAULT), open(500), closed(FILE_VIEWER_DEFAULT), closed(400)])
    expect(cols.explorer).toBe(EXPLORER_COLLAPSED)
    expect(cols.center).toBe(below - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED)
  })

  it('a closed explorer rides its rail and is never a concession target', () => {
    const cols = solve(900, [open(SIDEBAR_DEFAULT), closed(500), closed(FILE_VIEWER_DEFAULT), closed(400)])
    expect(cols.explorer).toBe(EXPLORER_COLLAPSED)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.center).toBe(900 - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED)
  })

  it('recovery is pure across the whole chain: re-widening restores the explorer preference', () => {
    const squeezed = solve(1050, [open(SIDEBAR_DEFAULT), open(500), closed(FILE_VIEWER_DEFAULT), closed(400)])
    expect(squeezed.explorer).toBe(EXPLORER_COLLAPSED)
    const restored = solve(2000, [open(SIDEBAR_DEFAULT), open(500), closed(FILE_VIEWER_DEFAULT), closed(400)])
    expect(restored.explorer).toBe(500)
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('side rails closed and viewport below CENTER_MIN: the rails hold and center takes the rest', () => {
    const cols = solve(500, [closed(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), closed(400)])
    expect(cols).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: 500 - SIDEBAR_COLLAPSED - EXPLORER_COLLAPSED,
      explorer: EXPLORER_COLLAPSED,
      fileViewer: 0,
      rightbar: 0,
    })
  })

  it('the sidebar rail holds its preference while the center falls below its floor', () => {
    const cols = solve(700, [open(SIDEBAR_DEFAULT), closed(EXPLORER_DEFAULT), closed(FILE_VIEWER_DEFAULT), closed(400)])
    expect(cols).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: 700 - SIDEBAR_DEFAULT - EXPLORER_COLLAPSED,
      explorer: EXPLORER_COLLAPSED,
      fileViewer: 0,
      rightbar: 0,
    })
  })
})
