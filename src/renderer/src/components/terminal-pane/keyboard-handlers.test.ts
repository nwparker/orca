/* eslint-disable max-lines -- Why: keyboard shortcut coverage shares one
   mocked React effect runtime across handler registration and dispatch cases. */
import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  matchFileSearchShortcut,
  matchSearchNavigate,
  useTerminalKeyboardShortcuts
} from './keyboard-handlers'

const reactEffectState = vi.hoisted(() => ({
  cleanups: [] as (() => void)[]
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useEffect: vi.fn((effect: () => void | (() => void)) => {
      const cleanup = effect()
      if (typeof cleanup === 'function') {
        reactEffectState.cleanups.push(cleanup)
      }
    })
  }
})

function makeKeyEvent(
  overrides: Partial<{
    key: string
    metaKey: boolean
    ctrlKey: boolean
    shiftKey: boolean
    altKey: boolean
    repeat: boolean
  }>
): Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'repeat'> {
  return {
    key: 'g',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    ...overrides
  }
}

describe('matchSearchNavigate', () => {
  const isMac = true
  const searchState = { query: 'hello', caseSensitive: false, regex: false }

  it('returns "next" for Cmd+G on macOS', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBe('next')
  })

  it('returns "previous" for Cmd+Shift+G on macOS', () => {
    const e = makeKeyEvent({ metaKey: true, shiftKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBe('previous')
  })

  it('returns null when search is closed', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(matchSearchNavigate(e, isMac, false, searchState)).toBeNull()
  })

  it('returns null when query is empty', () => {
    const e = makeKeyEvent({ metaKey: true })
    expect(
      matchSearchNavigate(e, isMac, true, { query: '', caseSensitive: false, regex: false })
    ).toBeNull()
  })

  it('returns null for wrong key', () => {
    const e = makeKeyEvent({ metaKey: true, key: 'f' })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBeNull()
  })

  it('returns null when alt is pressed', () => {
    const e = makeKeyEvent({ metaKey: true, altKey: true })
    expect(matchSearchNavigate(e, isMac, true, searchState)).toBeNull()
  })

  it('returns "next" for Ctrl+G on Linux/Windows', () => {
    const e = makeKeyEvent({ ctrlKey: true })
    expect(matchSearchNavigate(e, false, true, searchState)).toBe('next')
  })

  it('returns "previous" for Ctrl+Shift+G on Linux/Windows', () => {
    const e = makeKeyEvent({ ctrlKey: true, shiftKey: true })
    expect(matchSearchNavigate(e, false, true, searchState)).toBe('previous')
  })

  it('returns null for Ctrl+G on macOS (wrong modifier)', () => {
    const e = makeKeyEvent({ ctrlKey: true })
    expect(matchSearchNavigate(e, true, true, searchState)).toBeNull()
  })
})

describe('matchFileSearchShortcut', () => {
  it('matches Cmd+Shift+F on macOS', () => {
    expect(
      matchFileSearchShortcut(makeKeyEvent({ key: 'F', metaKey: true, shiftKey: true }), true)
    ).toBe(true)
  })

  it('matches Ctrl+Shift+F on Linux/Windows', () => {
    expect(
      matchFileSearchShortcut(makeKeyEvent({ key: 'F', ctrlKey: true, shiftKey: true }), false)
    ).toBe(true)
  })

  it('rejects repeats, alt, and the wrong platform modifier', () => {
    expect(
      matchFileSearchShortcut(
        makeKeyEvent({ key: 'F', metaKey: true, shiftKey: true, repeat: true }),
        true
      )
    ).toBe(false)
    expect(
      matchFileSearchShortcut(
        makeKeyEvent({ key: 'F', metaKey: true, shiftKey: true, altKey: true }),
        true
      )
    ).toBe(false)
    expect(
      matchFileSearchShortcut(makeKeyEvent({ key: 'F', ctrlKey: true, shiftKey: true }), true)
    ).toBe(false)
  })
})

type TestKeyboardEvent = Pick<
  KeyboardEvent,
  | 'key'
  | 'code'
  | 'metaKey'
  | 'ctrlKey'
  | 'shiftKey'
  | 'altKey'
  | 'repeat'
  | 'location'
  | 'target'
  | 'preventDefault'
  | 'stopImmediatePropagation'
>

type KeyboardListener = (event: KeyboardEvent) => void

let listeners: Record<string, KeyboardListener[]>
let addEventListener: ReturnType<typeof vi.fn>
let removeEventListener: ReturnType<typeof vi.fn>
let writeClipboardText: ReturnType<typeof vi.fn>

class FakeHTMLElement {
  classList = { contains: vi.fn(() => false) }
  isContentEditable = false
  closest = vi.fn(() => null)
}

function makeDomKeyboardEvent(overrides: Partial<TestKeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    location: 0,
    target: null,
    preventDefault: vi.fn(),
    stopImmediatePropagation: vi.fn(),
    ...overrides
  } as unknown as KeyboardEvent
}

function dispatch(type: string, event: KeyboardEvent): void {
  for (const listener of listeners[type] ?? []) {
    listener(event)
  }
}

async function flushAsyncHandlers(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function makePane(id: number) {
  return {
    id,
    terminal: {
      focus: vi.fn(),
      getSelection: vi.fn(() => 'selected text'),
      clear: vi.fn()
    },
    searchAddon: {
      findNext: vi.fn(),
      findPrevious: vi.fn()
    }
  }
}

function makeHookDeps(overrides: Record<string, unknown> = {}) {
  const pane = makePane(1)
  const secondPane = makePane(2)
  const manager = {
    getActivePane: vi.fn(() => pane),
    getPanes: vi.fn(() => [pane, secondPane]),
    setActivePane: vi.fn(),
    splitPane: vi.fn()
  }
  const sendInput = vi.fn()
  const getPtyId = vi.fn(() => 'pty-1')
  const deps = {
    isActive: true,
    keyboardScopeRef: { current: null },
    managerRef: { current: manager },
    paneTransportsRef: { current: new Map([[pane.id, { sendInput, getPtyId }]]) },
    paneCwdRef: { current: new Map() },
    fallbackCwd: '/repo',
    expandedPaneIdRef: { current: null },
    setExpandedPane: vi.fn(),
    restoreExpandedLayout: vi.fn(),
    refreshPaneSizes: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    toggleExpandPane: vi.fn(),
    setSearchOpen: vi.fn(),
    onRequestClosePane: vi.fn(),
    searchOpenRef: { current: false },
    searchStateRef: { current: { query: '', caseSensitive: false, regex: false } },
    macOptionAsAltRef: { current: 'false' },
    ...overrides
  } as unknown as Parameters<typeof useTerminalKeyboardShortcuts>[0]

  return { deps, pane, secondPane, manager, sendInput, getPtyId }
}

beforeEach(() => {
  reactEffectState.cleanups.length = 0
  listeners = {}
  addEventListener = vi.fn((type: string, listener: KeyboardListener) => {
    listeners[type] = [...(listeners[type] ?? []), listener]
  })
  removeEventListener = vi.fn((type: string, listener: KeyboardListener) => {
    listeners[type] = (listeners[type] ?? []).filter((candidate) => candidate !== listener)
  })
  writeClipboardText = vi.fn(() => Promise.resolve())

  vi.stubGlobal('HTMLElement', FakeHTMLElement)
  vi.stubGlobal('Node', FakeHTMLElement)
  vi.stubGlobal('navigator', { userAgent: 'Mac OS' })
  vi.stubGlobal('window', {
    addEventListener,
    removeEventListener,
    api: {
      pty: { getCwd: vi.fn(() => Promise.resolve('/ipc-cwd')) },
      ui: { writeClipboardText }
    }
  })
})

afterEach(() => {
  for (const cleanup of reactEffectState.cleanups) {
    cleanup()
  }
  vi.unstubAllGlobals()
})

describe('useTerminalKeyboardShortcuts', () => {
  it('registers capture listeners only while active and cleans them up', () => {
    useTerminalKeyboardShortcuts(makeHookDeps({ isActive: false }).deps)
    expect(addEventListener).not.toHaveBeenCalled()

    useTerminalKeyboardShortcuts(makeHookDeps().deps)

    expect(addEventListener).toHaveBeenCalledTimes(3)
    expect(addEventListener).toHaveBeenCalledWith('keydown', expect.any(Function), {
      capture: true
    })
    expect(addEventListener).toHaveBeenCalledWith('keyup', expect.any(Function), { capture: true })

    for (const cleanup of reactEffectState.cleanups) {
      cleanup()
    }
    reactEffectState.cleanups.length = 0

    expect(removeEventListener).toHaveBeenCalledTimes(3)
  })

  it('routes search, clipboard, focus, pane, and input shortcuts to terminal collaborators', async () => {
    const { deps, pane, secondPane, manager, sendInput } = makeHookDeps()
    useTerminalKeyboardShortcuts(deps)

    deps.searchOpenRef.current = true
    deps.searchStateRef.current = { query: 'needle', caseSensitive: true, regex: false }
    dispatch('keydown', makeDomKeyboardEvent({ key: 'g', code: 'KeyG', metaKey: true }))
    dispatch(
      'keydown',
      makeDomKeyboardEvent({ key: 'g', code: 'KeyG', metaKey: true, shiftKey: true })
    )

    expect(pane.searchAddon.findNext).toHaveBeenCalledWith('needle', {
      caseSensitive: true,
      regex: false
    })
    expect(pane.searchAddon.findPrevious).toHaveBeenCalledWith('needle', {
      caseSensitive: true,
      regex: false
    })
    expect(pane.terminal.focus).toHaveBeenCalledTimes(2)

    deps.searchOpenRef.current = false
    dispatch(
      'keydown',
      makeDomKeyboardEvent({ key: 'c', code: 'KeyC', metaKey: true, shiftKey: true })
    )
    await Promise.resolve()
    expect(writeClipboardText).toHaveBeenCalledWith('selected text')

    dispatch('keydown', makeDomKeyboardEvent({ key: 'f', code: 'KeyF', metaKey: true }))
    expect(deps.setSearchOpen).toHaveBeenCalledWith(expect.any(Function))

    dispatch('keydown', makeDomKeyboardEvent({ key: 'k', code: 'KeyK', metaKey: true }))
    expect(pane.terminal.clear).toHaveBeenCalled()

    deps.expandedPaneIdRef.current = pane.id
    dispatch('keydown', makeDomKeyboardEvent({ key: ']', code: 'BracketRight', metaKey: true }))
    expect(deps.setExpandedPane).toHaveBeenCalledWith(null)
    expect(deps.restoreExpandedLayout).toHaveBeenCalled()
    expect(deps.refreshPaneSizes).toHaveBeenCalledWith(true)
    expect(deps.persistLayoutSnapshot).toHaveBeenCalled()
    expect(manager.setActivePane).toHaveBeenCalledWith(secondPane.id, { focus: true })

    dispatch(
      'keydown',
      makeDomKeyboardEvent({ key: 'Enter', code: 'Enter', metaKey: true, shiftKey: true })
    )
    expect(deps.toggleExpandPane).toHaveBeenCalledWith(pane.id)

    dispatch('keydown', makeDomKeyboardEvent({ key: 'w', code: 'KeyW', metaKey: true }))
    expect(deps.onRequestClosePane).toHaveBeenCalledWith(pane.id)

    deps.paneCwdRef.current.set(pane.id, { cwd: '/from-osc7', confirmed: true })
    dispatch('keydown', makeDomKeyboardEvent({ key: 'd', code: 'KeyD', metaKey: true }))
    expect(manager.splitPane).toHaveBeenCalledWith(pane.id, 'vertical', { cwd: '/from-osc7' })

    dispatch('keydown', makeDomKeyboardEvent({ key: 'Enter', code: 'Enter', shiftKey: true }))
    expect(sendInput).toHaveBeenCalledWith('\x1b[13;2u')
  })

  it('resolves split cwd asynchronously when OSC 7 is unavailable', async () => {
    const { deps, pane, manager } = makeHookDeps()
    useTerminalKeyboardShortcuts(deps)

    dispatch('keydown', makeDomKeyboardEvent({ key: 'd', code: 'KeyD', metaKey: true }))
    await flushAsyncHandlers()

    expect(window.api.pty.getCwd).toHaveBeenCalledWith('pty-1')
    expect(manager.splitPane).toHaveBeenCalledWith(pane.id, 'vertical', { cwd: '/ipc-cwd' })
  })

  it('skips normal editable targets but allows the xterm helper textarea', () => {
    const { deps, pane } = makeHookDeps()
    useTerminalKeyboardShortcuts(deps)

    const editableTarget = new FakeHTMLElement()
    editableTarget.isContentEditable = true
    dispatch(
      'keydown',
      makeDomKeyboardEvent({
        key: 'k',
        code: 'KeyK',
        metaKey: true,
        target: editableTarget as unknown as EventTarget
      })
    )
    expect(pane.terminal.clear).not.toHaveBeenCalled()

    const helperTextarea = new FakeHTMLElement()
    helperTextarea.classList.contains.mockReturnValue(true)
    dispatch(
      'keydown',
      makeDomKeyboardEvent({
        key: 'k',
        code: 'KeyK',
        metaKey: true,
        target: helperTextarea as unknown as EventTarget
      })
    )
    expect(pane.terminal.clear).toHaveBeenCalled()
  })
})
