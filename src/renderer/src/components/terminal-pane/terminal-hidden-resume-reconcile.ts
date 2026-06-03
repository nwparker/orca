import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { isRemoteRuntimePtyId } from '@/runtime/runtime-terminal-inspection'
import type { PtyTransport } from './pty-transport'

type PaneSize = {
  cols: number
  rows: number
}

type RefreshableTerminal = {
  cols: number
  rows: number
  refresh: (start: number, end: number) => void
}

export type HiddenPaneSizes = Map<number | string, PaneSize>

export function captureHiddenPaneSizes(
  manager: PaneManager,
  paneTransports: Map<number, PtyTransport>
): HiddenPaneSizes {
  const sizes = new Map<number | string, PaneSize>()
  for (const pane of manager.getPanes()) {
    const size = {
      cols: pane.terminal.cols,
      rows: pane.terminal.rows
    }
    sizes.set(pane.id, size)
    const ptyId = paneTransports.get(pane.id)?.getPtyId() ?? pane.container?.dataset?.ptyId
    if (ptyId) {
      sizes.set(hiddenPtyKey(ptyId), size)
    }
  }
  return sizes
}

export function reconcileVisiblePanesAfterHiddenResume({
  manager,
  paneTransports,
  hiddenPaneSizes
}: {
  manager: PaneManager
  paneTransports: Map<number, PtyTransport>
  hiddenPaneSizes: HiddenPaneSizes
}): void {
  for (const pane of manager.getPanes()) {
    forceTerminalRefresh(pane.terminal)
    const directTransport = paneTransports.get(pane.id)
    const domPtyId = pane.container?.dataset?.ptyId ?? null
    const directPtyId = directTransport?.getPtyId() ?? null
    const ptyId = domPtyId ?? directPtyId
    const transport =
      directPtyId === ptyId ? directTransport : findTransportByPtyId(paneTransports, ptyId)
    const hiddenSize =
      hiddenPaneSizes.get(pane.id) ?? (ptyId ? hiddenPaneSizes.get(hiddenPtyKey(ptyId)) : undefined)
    if (
      hiddenSize &&
      hiddenSize.cols === pane.terminal.cols &&
      hiddenSize.rows === pane.terminal.rows
    ) {
      continue
    }
    if (!ptyId || getFitOverrideForPty(ptyId) || isPtyLocked(ptyId)) {
      continue
    }
    if (pane.terminal.cols <= 0 || pane.terminal.rows <= 0) {
      continue
    }
    if (isRemoteRuntimePtyId(ptyId)) {
      transport?.resize(pane.terminal.cols, pane.terminal.rows)
      continue
    }
    resizeAndPulseLocalPty(ptyId, pane.terminal.cols, pane.terminal.rows)
  }
}

function findTransportByPtyId(
  paneTransports: Map<number, PtyTransport>,
  ptyId: string | null
): PtyTransport | undefined {
  if (!ptyId) {
    return undefined
  }
  for (const transport of paneTransports.values()) {
    if (transport.getPtyId() === ptyId) {
      return transport
    }
  }
  return undefined
}

function resizeAndPulseLocalPty(ptyId: string, cols: number, rows: number): void {
  // Why: xterm redraws its buffer after fit, but an idle full-screen TUI only
  // repaints its own layout after the PTY has the new size and sees SIGWINCH.
  void window.api.pty.resizeAndSignal(ptyId, cols, rows, 'SIGWINCH').catch(() => {})
}

function forceTerminalRefresh(terminal: RefreshableTerminal): void {
  if (terminal.rows <= 0) {
    return
  }
  try {
    terminal.refresh(0, terminal.rows - 1)
  } catch {
    // Best effort; hidden/remount races can briefly expose a disposed xterm.
  }
}

function hiddenPtyKey(ptyId: string): string {
  return `pty:${ptyId}`
}
