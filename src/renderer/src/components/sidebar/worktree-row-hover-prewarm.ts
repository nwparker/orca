import { setTerminalPrewarmWorktrees } from '../terminal/terminal-worktree-prewarm'

// Long enough that sweeping or scrolling past rows never mounts them; short enough to finish before a typical press.
export const HOVER_PREWARM_DWELL_MS = 120
// Brief exits (e.g. toward a row action) must not drop the warm mount and pay it again.
export const HOVER_PREWARM_GRACE_MS = 1500

let dwellTimer: ReturnType<typeof setTimeout> | null = null
let dwellWorktreeId: string | null = null
let graceTimer: ReturnType<typeof setTimeout> | null = null
let prewarmedWorktreeId: string | null = null
let wheelListenerInstalled = false

function clearDwell(): void {
  if (dwellTimer !== null) {
    clearTimeout(dwellTimer)
  }
  dwellTimer = null
  dwellWorktreeId = null
}

function clearGrace(): void {
  if (graceTimer !== null) {
    clearTimeout(graceTimer)
  }
  graceTimer = null
}

function armDwell(worktreeId: string): void {
  clearDwell()
  dwellWorktreeId = worktreeId
  dwellTimer = setTimeout(() => {
    dwellTimer = null
    dwellWorktreeId = null
    clearGrace()
    prewarmedWorktreeId = worktreeId
    setTerminalPrewarmWorktrees('hover', [worktreeId])
  }, HOVER_PREWARM_DWELL_MS)
}

// Rows scrolling under a resting pointer fire pointerenter; restart the dwell so scrolling never prewarms.
function installWheelListener(): void {
  if (wheelListenerInstalled || typeof window === 'undefined') {
    return
  }
  wheelListenerInstalled = true
  window.addEventListener(
    'wheel',
    () => {
      if (dwellWorktreeId !== null) {
        armDwell(dwellWorktreeId)
      }
    },
    { capture: true, passive: true }
  )
}

export function noteWorktreeRowHoverStart(worktreeId: string): void {
  installWheelListener()
  if (prewarmedWorktreeId === worktreeId) {
    clearDwell()
    clearGrace()
    return
  }
  armDwell(worktreeId)
}

export function noteWorktreeRowHoverEnd(worktreeId: string): void {
  if (dwellWorktreeId === worktreeId) {
    clearDwell()
  }
  if (prewarmedWorktreeId !== worktreeId || graceTimer !== null) {
    return
  }
  graceTimer = setTimeout(() => {
    graceTimer = null
    prewarmedWorktreeId = null
    setTerminalPrewarmWorktrees('hover', [])
  }, HOVER_PREWARM_GRACE_MS)
}
