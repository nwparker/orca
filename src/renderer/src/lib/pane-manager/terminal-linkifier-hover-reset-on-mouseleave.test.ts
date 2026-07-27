import type { Terminal } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { installTerminalLinkifierHoverResetOnMouseLeave } from './terminal-linkifier-hover-reset-on-mouseleave'

type FakeLinkifier = { _lastBufferCell?: unknown; _activeLine?: number }

function createHarness(hasScreen = true): {
  terminal: Terminal
  linkifier: FakeLinkifier
  dispatchMouseLeave: () => void
} {
  let mouseLeaveHandler: (() => void) | null = null
  const screen = {
    addEventListener: vi.fn((_event: string, handler: () => void) => {
      mouseLeaveHandler = handler
    }),
    removeEventListener: vi.fn((_event: string, handler: () => void) => {
      if (mouseLeaveHandler === handler) {
        mouseLeaveHandler = null
      }
    })
  }
  const linkifier: FakeLinkifier = {
    _lastBufferCell: { x: 2, y: 3 },
    _activeLine: 3
  }
  const terminal = {
    element: {
      querySelector: vi.fn(() => (hasScreen ? screen : null))
    },
    _core: { linkifier }
  } as unknown as Terminal
  return {
    terminal,
    linkifier,
    dispatchMouseLeave: () => mouseLeaveHandler?.()
  }
}

describe('installTerminalLinkifierHoverResetOnMouseLeave', () => {
  it('resets the hover cache when the terminal surface loses the pointer', () => {
    const harness = createHarness()
    installTerminalLinkifierHoverResetOnMouseLeave(harness.terminal)

    harness.dispatchMouseLeave()

    expect(harness.linkifier._lastBufferCell).toBeUndefined()
    expect(harness.linkifier._activeLine).toBe(-1)
  })

  it('removes the listener on dispose', () => {
    const harness = createHarness()
    const disposable = installTerminalLinkifierHoverResetOnMouseLeave(harness.terminal)

    disposable.dispose()
    harness.dispatchMouseLeave()

    expect(harness.linkifier._lastBufferCell).toEqual({ x: 2, y: 3 })
    expect(harness.linkifier._activeLine).toBe(3)
  })

  it('degrades to a no-op when the screen is unavailable', () => {
    const harness = createHarness(false)

    expect(() =>
      installTerminalLinkifierHoverResetOnMouseLeave(harness.terminal).dispose()
    ).not.toThrow()
  })

  it('does not throw when xterm linkifier internals are unavailable', () => {
    const harness = createHarness()
    const terminal = harness.terminal as unknown as { _core?: unknown }
    terminal._core = undefined
    installTerminalLinkifierHoverResetOnMouseLeave(harness.terminal)

    expect(harness.dispatchMouseLeave).not.toThrow()
  })
})
