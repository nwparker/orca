// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { PtyTransport } from './pty-transport'
import {
  installTerminalImeCompositionRoute,
  XTERM_COMPOSITION_SESSION_END_EVENT,
  XTERM_COMPOSITION_SESSION_START_EVENT
} from './terminal-ime-composition-route'

function createTransport(ptyId: string | null): PtyTransport {
  return {
    getPtyId: vi.fn(() => ptyId)
  } as unknown as PtyTransport
}

function sessionEvent(type: string, id: number, data?: string): CustomEvent {
  return new CustomEvent(type, {
    bubbles: true,
    cancelable: true,
    detail: { id, data }
  })
}

function createHarness(ptyId = 'pty-original') {
  const element = document.createElement('div')
  const original = createTransport(ptyId)
  const state: {
    currentTransport: PtyTransport | undefined
  } = {
    currentTransport: original
  }
  const input = vi.fn()
  const route = installTerminalImeCompositionRoute({
    terminalElement: element,
    terminal: { input },
    capturedTransport: original,
    getCurrentTransport: () => state.currentTransport
  })
  const start = (id: number) =>
    element.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_START_EVENT, id))
  const end = (id: number, data: string) =>
    element.dispatchEvent(sessionEvent(XTERM_COMPOSITION_SESSION_END_EVENT, id, data))
  return { element, original, state, input, route, start, end }
}

describe('installTerminalImeCompositionRoute', () => {
  it.each(['visible blur', 'terminal tab switch', 'split pane switch'])(
    'delivers one Hangul commit to the captured route after %s',
    () => {
      const harness = createHarness()
      harness.start(1)

      expect(harness.end(1, '한')).toBe(false)
      expect(harness.input).toHaveBeenCalledExactlyOnceWith('한')
    }
  )

  it('never routes a switched composition to an unrelated transport', () => {
    const harness = createHarness()
    harness.start(1)
    harness.state.currentTransport = createTransport('pty-unrelated')

    harness.end(1, '한')

    expect(harness.input).not.toHaveBeenCalled()
  })

  it('finalizes empty cancellation without leaking into the next session', () => {
    const harness = createHarness()
    harness.start(1)
    harness.end(1, '')
    harness.start(2)
    harness.end(1, '한')
    harness.end(2, '글')

    expect(harness.input).toHaveBeenCalledExactlyOnceWith('글')
  })

  it('ignores duplicate and late composition completion', () => {
    const harness = createHarness()
    harness.start(1)
    harness.end(1, '한')
    harness.end(1, '한')

    expect(harness.input).toHaveBeenCalledExactlyOnceWith('한')
  })

  it('keeps the prior captured session until its delayed completion', () => {
    const harness = createHarness()
    harness.start(1)
    harness.start(2)
    harness.end(1, '안')
    harness.end(2, '녕')

    expect(harness.input.mock.calls).toEqual([['안'], ['녕']])
  })

  it('drops a commit after same-pane PTY replacement', () => {
    const harness = createHarness()
    harness.start(1)
    vi.mocked(harness.original.getPtyId).mockReturnValue('pty-replacement')

    harness.end(1, '한')

    expect(harness.input).not.toHaveBeenCalled()
  })

  it('drops a commit after SSH reconnect replaces the transport', () => {
    const harness = createHarness('remote:env:pty-original')
    harness.start(1)
    harness.state.currentTransport = createTransport('remote:env:pty-replacement')

    harness.end(1, '한')

    expect(harness.input).not.toHaveBeenCalled()
  })

  it.each(['terminal close', 'tab unmount'])(
    'releases the captured session and listeners on %s',
    () => {
      const harness = createHarness()
      harness.start(1)
      harness.route.dispose()

      expect(harness.end(1, '한')).toBe(true)
      expect(harness.input).not.toHaveBeenCalled()
    }
  )
})
