// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTerminalImeDeferredNewlineSender,
  sendTerminalInputAfterComposition
} from './terminal-ime-deferred-newline'

describe('sendTerminalInputAfterComposition', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('sends the newline one macrotask after compositionend so the glyph flushes first', () => {
    const el = document.createElement('div')
    const send = vi.fn()

    sendTerminalInputAfterComposition(el, send)
    expect(send).not.toHaveBeenCalled()

    el.dispatchEvent(new Event('compositionend'))
    // Deferred a macrotask so xterm's own post-compositionend flush runs first.
    expect(send).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('falls back to sending when no compositionend arrives', () => {
    const el = document.createElement('div')
    const send = vi.fn()

    sendTerminalInputAfterComposition(el, send)
    vi.runAllTimers()

    expect(send).toHaveBeenCalledTimes(1)
  })

  it('sends only once and drops the listener after firing', () => {
    const el = document.createElement('div')
    const send = vi.fn()

    sendTerminalInputAfterComposition(el, send)
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    // A later composition on the same terminal must not re-fire the stale newline.
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('does not double-send when compositionend arrives after the fallback fired', () => {
    const el = document.createElement('div')
    const send = vi.fn()

    sendTerminalInputAfterComposition(el, send)
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('still delivers the input on the next macrotask without a terminal element', () => {
    const send = vi.fn()

    sendTerminalInputAfterComposition(null, send)
    expect(send).not.toHaveBeenCalled()

    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('createTerminalImeDeferredNewlineSender', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const createSender = () => createTerminalImeDeferredNewlineSender()
  const enter = (timeStamp: number, code = 'Enter') => ({ code, timeStamp })

  it('absorbs the re-dispatch while the deferred send is still in flight, exactly once', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createSender()

    sender.defer(enter(10), el, send)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)

    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)
    // The credit was consumed pre-send, so nothing lingers to eat a real Enter.
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })

  it('absorbs after the deferred send even if focus moved to another pane', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createSender()

    sender.defer(enter(10), el, send)
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })

  it('keeps a credit across the balancing keyup copied from the same native event', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    sender.releaseRedispatchedEnter(enter(10))
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
  })

  it('releases an unused credit on a later physical keyup', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    sender.releaseRedispatchedEnter(enter(11))
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })

  it('retires stale credit when a genuinely new Enter begins without a redispatch', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())

    expect(sender.absorbRedispatchedEnter(enter(20))).toBe(false)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })

  it('absorbs a matching repeated composition cycle but not a new plain repeat', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    expect(sender.absorbRedispatchedEnter(enter(20))).toBe(false)

    sender.defer(enter(30), el, vi.fn())
    expect(sender.absorbRedispatchedEnter(enter(30))).toBe(true)
  })

  it('tracks the main and numpad Enter keys independently', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    expect(sender.absorbRedispatchedEnter(enter(10, 'NumpadEnter'))).toBe(false)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
  })

  it('tracks two overlapping Enter cycles independently by native timestamp', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    sender.defer(enter(20), el, vi.fn())
    expect(sender.absorbRedispatchedEnter(enter(20))).toBe(true)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
    expect(sender.absorbRedispatchedEnter(enter(20))).toBe(false)
  })

  it('keeps a re-dispatch credit on the fallback path', () => {
    const el = document.createElement('div')
    const send = vi.fn()
    const sender = createSender()

    sender.defer(enter(10), el, send)
    vi.runAllTimers()
    expect(send).toHaveBeenCalledTimes(1)

    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
  })

  it('still delivers without a terminal element and keeps one credit', () => {
    const send = vi.fn()
    const sender = createSender()

    sender.defer(enter(10), null, send)
    vi.runAllTimers()

    expect(send).toHaveBeenCalledTimes(1)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(true)
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })

  it('clears credits after a missed keyup when the window blurs', () => {
    const el = document.createElement('div')
    const sender = createSender()

    sender.defer(enter(10), el, vi.fn())
    el.dispatchEvent(new Event('compositionend'))
    vi.runAllTimers()

    sender.clearRedispatchedEnters()
    expect(sender.absorbRedispatchedEnter(enter(10))).toBe(false)
  })
})
