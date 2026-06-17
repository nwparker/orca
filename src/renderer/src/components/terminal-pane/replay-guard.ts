import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { writeForegroundTerminalChunk } from '@/lib/pane-manager/pane-terminal-foreground-render-settle'

// Why: xterm.js auto-responds to terminal query sequences (DA1 `CSI c`,
// DECRQM `CSI ? Ps $ p`, OSC 10/11 color queries, focus events, CPR) by
// emitting the reply through its onData callback. In pty-connection.ts that
// callback is wired directly to `transport.sendInput`, which pipes the reply
// to the shell's stdin. When we restore terminal state at startup or on
// reattach we write recorded PTY bytes back into xterm — including any
// queries the previous agent CLI emitted — and the auto-replies end up as
// stray characters on the new shell's prompt (e.g. `?1;2c`, `2026;2$y`,
// OSC 10/11 color fragments).
//
// xterm does not expose a `wasUserInput` flag on its public onData, so we
// cannot distinguish replay-induced replies from real keystrokes after the
// fact. Instead, we track an in-flight replay counter per pane: callers
// replay into xterm via `replayIntoTerminal`, which increments the counter,
// writes, and decrements in xterm's write-completion callback. The onData
// handler in pty-connection.ts drops data while the counter is non-zero.
//
// The guard window is normally bounded by xterm's own parse completion, so
// only replies generated while parsing the replayed bytes are suppressed.
// Some renderer state (notably restored synchronized output) can strand an
// xterm write callback indefinitely, so a short safety release prevents real
// user input from being black-holed forever.

export type ReplayingPanesRef = React.RefObject<Map<number, number>>

const REPLAY_GUARD_SAFETY_RELEASE_MS = 1000

export function isPaneReplaying(ref: ReplayingPanesRef, paneId: number): boolean {
  return (ref.current.get(paneId) ?? 0) > 0
}

function releaseReplayGuard(map: Map<number, number>, paneId: number): void {
  const remaining = (map.get(paneId) ?? 1) - 1
  if (remaining <= 0) {
    map.delete(paneId)
  } else {
    map.set(paneId, remaining)
  }
}

function makeReplayGuardRelease(
  map: Map<number, number>,
  paneId: number,
  onRelease?: () => void
): () => void {
  let released = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const release = (): void => {
    if (released) {
      return
    }
    released = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    releaseReplayGuard(map, paneId)
    onRelease?.()
  }
  timer = setTimeout(release, REPLAY_GUARD_SAFETY_RELEASE_MS)
  return release
}

/** Writes `data` into the pane's terminal with the replay guard engaged,
 *  so xterm's auto-replies to embedded query sequences do not leak to the
 *  shell as input. The counter increments/decrements so nested replays
 *  (e.g. clear-screen preamble + snapshot body) compose correctly. */
export function replayIntoTerminal(
  pane: ManagedPane,
  replayingPanesRef: ReplayingPanesRef,
  data: string
): void {
  if (!data) {
    return
  }
  const map = replayingPanesRef.current
  map.set(pane.id, (map.get(pane.id) ?? 0) + 1)
  const release = makeReplayGuardRelease(map, pane.id)
  // Why: hidden/snapshot replay bypasses the live foreground write path, but
  // WebGL/canvas renderers still need a post-parse repaint to drop stale cells.
  writeForegroundTerminalChunk(pane.terminal, data, {
    forceViewportRefresh: true,
    followupViewportRefresh: true,
    onParsed: release
  })
}

export function replayIntoTerminalAsync(
  pane: ManagedPane,
  replayingPanesRef: ReplayingPanesRef,
  data: string
): Promise<void> {
  if (!data) {
    return Promise.resolve()
  }
  const map = replayingPanesRef.current
  map.set(pane.id, (map.get(pane.id) ?? 0) + 1)
  return new Promise((resolve) => {
    const release = makeReplayGuardRelease(map, pane.id, resolve)
    writeForegroundTerminalChunk(pane.terminal, data, {
      forceViewportRefresh: true,
      followupViewportRefresh: true,
      onParsed: release
    })
  })
}
