// @ts-nocheck -- Hook test uses minimal fake PaneManager/PtyTransport/DOM objects.
/* eslint-disable react-hooks/rules-of-hooks -- Why: this hook harness invokes
   the hook directly against a mocked React runtime to inspect returned handlers. */
import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalPaneContextMenu } from './use-terminal-pane-context-menu'
import { resolveSplitCwd } from './resolve-split-cwd'
import { sendTerminalQuickCommandToPane } from './terminal-quick-command-dispatch'

const reactRuntime = vi.hoisted(() => ({
  cleanups: [] as (() => void)[],
  refs: [] as { current: unknown }[],
  refIndex: 0,
  stateIndex: 0,
  states: [] as unknown[]
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => {
      const cleanup = effect()
      if (typeof cleanup === 'function') {
        reactRuntime.cleanups.push(cleanup)
      }
    },
    useRef: (initial: unknown) => {
      const index = reactRuntime.refIndex++
      reactRuntime.refs[index] ??= { current: initial }
      return reactRuntime.refs[index]
    },
    useState: (initial: unknown) => {
      const index = reactRuntime.stateIndex++
      if (!(index in reactRuntime.states)) {
        reactRuntime.states[index] = initial
      }
      const setState = (next: unknown): void => {
        reactRuntime.states[index] =
          typeof next === 'function'
            ? (next as (previous: unknown) => unknown)(reactRuntime.states[index])
            : next
      }
      return [reactRuntime.states[index], setState]
    }
  }
})

vi.mock('./resolve-split-cwd', () => ({
  resolveSplitCwd: vi.fn(() => Promise.resolve('/async-cwd'))
}))

vi.mock('./terminal-quick-command-dispatch', () => ({
  sendTerminalQuickCommandToPane: vi.fn()
}))

type Listener = (event: Event) => void
type FakeEvent = {
  clientX: number
  clientY: number
  ctrlKey: boolean
  currentTarget: { getBoundingClientRect: () => { left: number; top: number } }
  preventDefault: ReturnType<typeof vi.fn>
  stopPropagation: ReturnType<typeof vi.fn>
  target: EventTarget
}

let listeners: Record<string, Listener[]>
let readClipboardText: ReturnType<typeof vi.fn>
let saveClipboardImageAsTempFile: ReturnType<typeof vi.fn>
let writeClipboardText: ReturnType<typeof vi.fn>

class FakeNode {
  name: string
  constructor(name: string) {
    this.name = name
  }
}

function makePane(id: number, target: FakeNode) {
  return {
    id,
    container: {
      contains: vi.fn((candidate: EventTarget) => candidate === target)
    },
    terminal: {
      clear: vi.fn(),
      clearSelection: vi.fn(),
      focus: vi.fn(),
      getSelection: vi.fn(() => 'selected text'),
      paste: vi.fn()
    }
  }
}

function resetReactRuntime(): void {
  reactRuntime.cleanups = []
  reactRuntime.refs = []
  reactRuntime.refIndex = 0
  reactRuntime.stateIndex = 0
  reactRuntime.states = []
}

function renderHook(args: {
  manager?: ReturnType<typeof makeManager> | null
  paneCwd?: Map<number, { cwd: string; confirmed: boolean }>
  rightClickToPaste?: boolean
}) {
  reactRuntime.refIndex = 0
  reactRuntime.stateIndex = 0
  const paneTransports = new Map([[1, { getPtyId: vi.fn(() => 'pty-1') }]])
  return useTerminalPaneContextMenu({
    fallbackCwd: '/repo',
    managerRef: { current: 'manager' in args ? (args.manager ?? null) : makeManager().manager },
    onRequestClosePane: vi.fn(),
    onSetTitle: vi.fn(),
    paneCwdRef: { current: args.paneCwd ?? new Map() },
    paneTransportsRef: { current: paneTransports },
    rightClickToPaste: args.rightClickToPaste ?? false,
    toggleExpandPane: vi.fn()
  })
}

function makeManager() {
  const firstTarget = new FakeNode('first')
  const secondTarget = new FakeNode('second')
  const panes = [makePane(1, firstTarget), makePane(2, secondTarget)]
  const manager = {
    getActivePane: vi.fn(() => panes[0]),
    getPanes: vi.fn(() => panes),
    splitPane: vi.fn()
  }
  return { firstTarget, manager, panes, secondTarget }
}

function makeContextMenuEvent(target: EventTarget): FakeEvent {
  return {
    clientX: 30,
    clientY: 45,
    ctrlKey: false,
    currentTarget: { getBoundingClientRect: () => ({ left: 10, top: 5 }) },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target
  }
}

function dispatchWindowEvent(type: string): void {
  for (const listener of listeners[type] ?? []) {
    listener(new Event(type))
  }
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  resetReactRuntime()
  vi.clearAllMocks()
  listeners = {}
  readClipboardText = vi.fn(() => Promise.resolve('clipboard text'))
  saveClipboardImageAsTempFile = vi.fn(() => Promise.resolve('/tmp/clipboard.png'))
  writeClipboardText = vi.fn(() => Promise.resolve())
  vi.stubGlobal('Node', FakeNode)
  vi.stubGlobal('window', {
    addEventListener: vi.fn((type: string, listener: Listener) => {
      listeners[type] = [...(listeners[type] ?? []), listener]
    }),
    api: {
      ui: {
        readClipboardText,
        saveClipboardImageAsTempFile,
        writeClipboardText
      }
    },
    dispatchEvent: vi.fn((event: Event) => {
      dispatchWindowEvent(event.type)
      return true
    }),
    removeEventListener: vi.fn((type: string, listener: Listener) => {
      listeners[type] = (listeners[type] ?? []).filter((candidate) => candidate !== listener)
    })
  })
})

afterEach(() => {
  for (const cleanup of reactRuntime.cleanups) {
    cleanup()
  }
  vi.unstubAllGlobals()
})

describe('useTerminalPaneContextMenu', () => {
  it('copies, pastes, splits, clears, closes, expands, titles, and dispatches quick commands', async () => {
    const { manager, panes } = makeManager()
    const paneCwd = new Map([[1, { cwd: '/cached-cwd', confirmed: true }]])
    const menu = renderHook({
      manager,
      paneCwd
    })

    await menu.onCopy()
    expect(writeClipboardText).toHaveBeenCalledWith('selected text')
    expect(panes[0].terminal.focus).toHaveBeenCalled()

    await menu.onPaste()
    expect(panes[0].terminal.paste).toHaveBeenCalledWith('clipboard text')

    readClipboardText.mockResolvedValueOnce('')
    await menu.onPaste()
    expect(saveClipboardImageAsTempFile).toHaveBeenCalled()
    expect(panes[0].terminal.paste).toHaveBeenCalledWith('/tmp/clipboard.png')

    menu.onSplitRight()
    expect(manager.splitPane).toHaveBeenCalledWith(1, 'vertical', { cwd: '/cached-cwd' })

    paneCwd.clear()
    menu.onSplitDown()
    await flushAsync()
    expect(resolveSplitCwd).toHaveBeenCalled()
    expect(manager.splitPane).toHaveBeenCalledWith(1, 'horizontal', { cwd: '/async-cwd' })

    menu.onClosePane()
    menu.onClearScreen()
    menu.onQuickCommand({ label: 'List', command: 'ls' })
    menu.onToggleExpand()
    menu.onSetTitle()

    expect(menu.paneCount).toBe(2)
    expect(menu.menuPaneId).toBe(1)
    expect(panes[0].terminal.clear).toHaveBeenCalled()
    expect(sendTerminalQuickCommandToPane).toHaveBeenCalledWith({
      command: { label: 'List', command: 'ls' },
      pane: panes[0],
      transport: expect.any(Object)
    })
  })

  it('opens the menu at the clicked pane and closes old menus after the open guard expires', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    const { manager, secondTarget } = makeManager()
    const menu = renderHook({ manager })
    const event = makeContextMenuEvent(secondTarget)

    menu.onContextMenuCapture(event as unknown as ReactModule.MouseEvent<HTMLDivElement>)

    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.dispatchEvent).toHaveBeenCalled()
    expect(reactRuntime.states[0]).toBe(true)
    expect(reactRuntime.states[1]).toEqual({ x: 20, y: 40 })

    dispatchWindowEvent('orca-close-all-context-menus')
    expect(reactRuntime.states[0]).toBe(true)

    vi.setSystemTime(1200)
    dispatchWindowEvent('orca-close-all-context-menus')
    expect(reactRuntime.states[0]).toBe(false)
    vi.useRealTimers()
  })

  it('uses right-click copy-or-paste mode without opening the menu', async () => {
    const { firstTarget, manager, panes } = makeManager()
    const menu = renderHook({ manager, rightClickToPaste: true })
    const event = makeContextMenuEvent(firstTarget)

    menu.onContextMenuCapture(event as unknown as ReactModule.MouseEvent<HTMLDivElement>)

    expect(event.stopPropagation).toHaveBeenCalled()
    expect(writeClipboardText).toHaveBeenCalledWith('selected text')
    expect(panes[0].terminal.clearSelection).toHaveBeenCalled()
    expect(reactRuntime.states[0]).toBe(false)

    panes[0].terminal.getSelection.mockReturnValueOnce('')
    readClipboardText.mockResolvedValueOnce('paste from right click')
    menu.onContextMenuCapture(event as unknown as ReactModule.MouseEvent<HTMLDivElement>)
    await flushAsync()
    expect(panes[0].terminal.paste).toHaveBeenCalledWith('paste from right click')
  })

  it('no-ops safely without a manager or DOM Node target', async () => {
    const menu = renderHook({ manager: null })
    await menu.onCopy()
    await menu.onPaste()
    menu.onSplitRight()
    menu.onClosePane()
    menu.onClearScreen()
    menu.onQuickCommand({ label: 'Noop', command: 'true' })
    menu.onToggleExpand()
    menu.onSetTitle()

    const event = makeContextMenuEvent({} as EventTarget)
    menu.onContextMenuCapture(event as unknown as ReactModule.MouseEvent<HTMLDivElement>)

    expect(writeClipboardText).not.toHaveBeenCalled()
    expect(resolveSplitCwd).not.toHaveBeenCalled()
    expect(sendTerminalQuickCommandToPane).not.toHaveBeenCalled()
  })
})
