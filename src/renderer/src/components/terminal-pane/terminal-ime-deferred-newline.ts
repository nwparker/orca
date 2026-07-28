export const TERMINAL_IME_DEFERRED_NEWLINE_FALLBACK_MS = 200
export const TERMINAL_IME_ENTER_REDISPATCH_ABSORB_WINDOW_MS = 50

export function sendTerminalInputAfterComposition(
  terminalElement: HTMLElement | null | undefined,
  send: () => void,
  options?: { fallbackMs?: number }
): void {
  if (!terminalElement) {
    window.setTimeout(send, 0)
    return
  }

  const fallbackMs = options?.fallbackMs ?? TERMINAL_IME_DEFERRED_NEWLINE_FALLBACK_MS
  let done = false

  const finish = (): void => {
    if (done) {
      return
    }
    done = true
    terminalElement.removeEventListener('compositionend', onCompositionEnd)
    window.clearTimeout(fallbackTimer)
    // xterm flushes the committed glyph after compositionend.
    window.setTimeout(send, 0)
  }

  const onCompositionEnd = (): void => finish()
  terminalElement.addEventListener('compositionend', onCompositionEnd)
  const fallbackTimer = window.setTimeout(finish, fallbackMs)
}

export type TerminalImeDeferredNewlineSender = {
  defer: (paneId: number, terminalElement: HTMLElement | null | undefined, send: () => void) => void
  absorbRedispatchedEnter: (paneId: number) => boolean
}

type PaneDeferredNewlineState = {
  inFlightSends: number
  absorbCredits: number
  absorbDeadline: number | null
}

export function createTerminalImeDeferredNewlineSender(): TerminalImeDeferredNewlineSender {
  const statesByPaneId = new Map<number, PaneDeferredNewlineState>()

  const cleanUpIfSettled = (paneId: number, state: PaneDeferredNewlineState): void => {
    if (state.inFlightSends <= 0 && state.absorbCredits <= 0) {
      statesByPaneId.delete(paneId)
    }
  }

  return {
    defer: (paneId, terminalElement, send) => {
      const state = statesByPaneId.get(paneId) ?? {
        inFlightSends: 0,
        absorbCredits: 0,
        absorbDeadline: null
      }
      state.inFlightSends += 1
      state.absorbCredits += 1
      state.absorbDeadline = null
      statesByPaneId.set(paneId, state)
      sendTerminalInputAfterComposition(terminalElement, () => {
        state.inFlightSends -= 1
        if (state.inFlightSends <= 0 && state.absorbCredits > 0) {
          state.absorbDeadline = Date.now() + TERMINAL_IME_ENTER_REDISPATCH_ABSORB_WINDOW_MS
        }
        cleanUpIfSettled(paneId, state)
        send()
      })
    },
    absorbRedispatchedEnter: (paneId) => {
      const state = statesByPaneId.get(paneId)
      if (!state || state.absorbCredits <= 0) {
        return false
      }
      if (
        state.inFlightSends <= 0 &&
        (state.absorbDeadline === null || Date.now() > state.absorbDeadline)
      ) {
        statesByPaneId.delete(paneId)
        return false
      }
      state.absorbCredits -= 1
      cleanUpIfSettled(paneId, state)
      return true
    }
  }
}
