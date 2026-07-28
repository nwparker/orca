import type { IDisposable, Terminal } from '@xterm/xterm'
import type { PtyTransport } from './pty-transport'

export const XTERM_COMPOSITION_SESSION_START_EVENT = 'xterm-composition-session-start'
export const XTERM_COMPOSITION_SESSION_END_EVENT = 'xterm-composition-session-end'

type CompositionSessionDetail = {
  id: number
  data?: string
}

type CapturedCompositionSession = {
  id: number
  ptyId: string | null
}

function getCompositionDetail(event: Event): CompositionSessionDetail | null {
  if (!(event instanceof CustomEvent)) {
    return null
  }
  const detail = event.detail as Partial<CompositionSessionDetail> | null
  if (!detail || !Number.isSafeInteger(detail.id) || detail.id! <= 0) {
    return null
  }
  return {
    id: detail.id!,
    data: typeof detail.data === 'string' ? detail.data : undefined
  }
}

export function installTerminalImeCompositionRoute(args: {
  terminalElement: HTMLElement | null | undefined
  terminal: Pick<Terminal, 'input'>
  capturedTransport: PtyTransport
  getCurrentTransport: () => PtyTransport | undefined
}): IDisposable {
  const terminalElement = args.terminalElement
  let session: CapturedCompositionSession | null = null
  let previousSession: CapturedCompositionSession | null = null
  let disposed = false

  if (
    !terminalElement ||
    typeof terminalElement.addEventListener !== 'function' ||
    typeof terminalElement.removeEventListener !== 'function'
  ) {
    return { dispose: () => undefined }
  }

  const onSessionStart = (event: Event): void => {
    const detail = getCompositionDetail(event)
    if (!detail || disposed) {
      return
    }
    previousSession = session
    session = {
      id: detail.id,
      ptyId: args.capturedTransport.getPtyId()
    }
  }

  const onSessionEnd = (event: Event): void => {
    const detail = getCompositionDetail(event)
    if (!detail) {
      return
    }
    event.preventDefault()
    const captured =
      session?.id === detail.id
        ? session
        : previousSession?.id === detail.id
          ? previousSession
          : null
    if (!captured) {
      return
    }
    if (session === captured) {
      session = null
    }
    if (previousSession === captured) {
      previousSession = null
    }
    if (
      disposed ||
      !detail.data ||
      captured.ptyId === null ||
      args.getCurrentTransport() !== args.capturedTransport ||
      args.capturedTransport.getPtyId() !== captured.ptyId
    ) {
      return
    }
    args.terminal.input(detail.data)
  }

  terminalElement.addEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, onSessionStart)
  terminalElement.addEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onSessionEnd)

  return {
    dispose: () => {
      disposed = true
      session = null
      previousSession = null
      terminalElement.removeEventListener(XTERM_COMPOSITION_SESSION_START_EVENT, onSessionStart)
      terminalElement.removeEventListener(XTERM_COMPOSITION_SESSION_END_EVENT, onSessionEnd)
    }
  }
}
