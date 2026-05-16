/* eslint-disable max-lines, react-hooks/rules-of-hooks -- Why: the lifecycle hook coordinates PaneManager,
   PTY binding, terminal parsers, runtime graph publication, and cleanup; the
   test keeps the integration mock in one place so those contracts remain visible. */
import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOSE_TERMINAL_PANE_EVENT, SPLIT_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import {
  splitPaneWithOneShotStartup,
  useTerminalPaneLifecycle
} from './use-terminal-pane-lifecycle'

const lifecycleMocks = vi.hoisted(() => ({
  applyExpandedLayoutTo: vi.fn(),
  applyTerminalAppearance: vi.fn(),
  clearSelection: vi.fn(),
  closeTab: vi.fn(),
  connectPanePty: vi.fn(),
  createFilePathLinkProvider: vi.fn(() => ({ provideLinks: vi.fn() })),
  dropAgentStatus: vi.fn(),
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  getRemoteRuntimePtyEnvironmentId: vi.fn(() => 'env-pty'),
  handleOscLink: vi.fn(),
  installMode2031Handlers: vi.fn(() => [{ dispose: vi.fn() }]),
  installMouseHideWhileTyping: vi.fn(() => ({ dispose: vi.fn() })),
  managers: [] as unknown[],
  mode2031SequenceFor: vi.fn((mode: string) => `mode:${mode}`),
  parseOsc52: vi.fn(() => ({ kind: 'write', text: 'osc52 text' })),
  parseOsc7: vi.fn(() => '/osc7-cwd'),
  registerRuntimeTerminalTab: vi.fn(() => vi.fn()),
  replayTerminalLayout: vi.fn(),
  restoreExpandedLayoutFrom: vi.fn(),
  restoreScrollbackBuffers: vi.fn(),
  scheduleRuntimeGraphSync: vi.fn(),
  setCacheTimerStartedAt: vi.fn(),
  shouldBypassXtermKeydown: vi.fn(() => false)
}))

const reactRuntime = vi.hoisted(() => ({
  cleanups: [] as (() => void)[]
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
    useRef: <T>(value: T) => ({ current: value })
  }
})

vi.mock('@/store', () => {
  const useAppStore = vi.fn()
  Object.assign(useAppStore, {
    getState: () => ({
      allWorktrees: () => [{ id: 'wt-1', path: '/repo/worktree' }],
      closeTab: lifecycleMocks.closeTab,
      dropAgentStatus: lifecycleMocks.dropAgentStatus,
      setCacheTimerStartedAt: lifecycleMocks.setCacheTimerStartedAt,
      runtimePaneTitlesByTabId: { 'tab-1': { 1: 'Pane 1', 2: 'Pane 2' } },
      tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] }
    })
  })
  return { useAppStore }
})

vi.mock('@/lib/pane-manager/pane-manager', () => {
  type PaneOptions = Record<string, (...args: never[]) => unknown>

  function disposable() {
    return { dispose: vi.fn() }
  }

  function createPane(id: number) {
    const oscHandlers = new Map<number, (data: string) => boolean>()
    const pane = {
      id,
      leafId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      container: {},
      linkTooltip: { style: { display: 'none' }, textContent: '' },
      oscHandlers,
      selectionCallback: null as null | (() => void),
      terminal: {
        attachCustomKeyEventHandler: vi.fn(),
        clearSelection: lifecycleMocks.clearSelection,
        getSelection: vi.fn(() => 'selected text'),
        hasSelection: vi.fn(() => true),
        onSelectionChange: vi.fn((callback: () => void) => {
          pane.selectionCallback = callback
          return disposable()
        }),
        options: {} as Record<string, unknown>,
        parser: {
          registerOscHandler: vi.fn((code: number, callback: (data: string) => boolean) => {
            oscHandlers.set(code, callback)
            return disposable()
          })
        },
        registerLinkProvider: vi.fn(() => disposable())
      }
    }
    return pane
  }

  class PaneManager {
    activePaneId: number | null = null
    container: unknown
    nextPaneId = 1
    options: PaneOptions
    panes: ReturnType<typeof createPane>[] = []
    destroyed = false
    gpuAcceleration: string | null = null

    constructor(container: unknown, options: PaneOptions) {
      this.container = container
      this.options = options
      lifecycleMocks.managers.push(this)
    }

    __createPane(spawnHints?: { cwd?: string }) {
      const pane = createPane(this.nextPaneId++)
      this.panes.push(pane)
      this.activePaneId ??= pane.id
      this.options.onPaneCreated?.(pane as never, spawnHints as never)
      return pane
    }

    closePane(paneId: number): void {
      const closedPane = this.panes.find((pane) => pane.id === paneId)
      this.panes = this.panes.filter((pane) => pane.id !== paneId)
      if (this.activePaneId === paneId) {
        this.activePaneId = this.panes[0]?.id ?? null
      }
      this.options.onPaneClosed?.(paneId as never, closedPane as never)
      this.options.onLayoutChanged?.()
    }

    destroy(): void {
      this.destroyed = true
    }

    getActivePane() {
      return this.panes.find((pane) => pane.id === this.activePaneId) ?? this.panes[0] ?? null
    }

    getPanes() {
      return this.panes
    }

    setActivePane(paneId: number): void {
      this.activePaneId = paneId
      const pane = this.getActivePane()
      if (pane) {
        this.options.onActivePaneChange?.(pane as never)
      }
    }

    setTerminalGpuAcceleration(value: string): void {
      this.gpuAcceleration = value
    }

    splitPane(
      _paneId: number,
      _direction: 'horizontal' | 'vertical',
      spawnHints?: { cwd?: string }
    ) {
      const pane = this.__createPane(spawnHints)
      this.options.onLayoutChanged?.()
      return pane
    }
  }

  return { PaneManager }
})

vi.mock('./layout-serialization', () => ({
  buildFontFamily: vi.fn((font: string) => font || 'monospace'),
  collectLeafIdsInReplayCreationOrder: vi.fn(() => ['leaf-1']),
  normalizeTerminalLayoutSnapshot: vi.fn((snapshot) => ({ snapshot, changed: false })),
  replayTerminalLayout: lifecycleMocks.replayTerminalLayout,
  restoreScrollbackBuffers: lifecycleMocks.restoreScrollbackBuffers
}))

vi.mock('./pty-connection', () => ({
  connectPanePty: lifecycleMocks.connectPanePty
}))

vi.mock('./terminal-link-handlers', () => ({
  createFilePathLinkProvider: lifecycleMocks.createFilePathLinkProvider,
  getTerminalFileOpenHint: vi.fn(() => 'open file'),
  getTerminalUrlOpenHint: vi.fn(() => 'open url'),
  handleOscLink: lifecycleMocks.handleOscLink
}))

vi.mock('./expand-collapse', () => ({
  applyExpandedLayoutTo: lifecycleMocks.applyExpandedLayoutTo,
  restoreExpandedLayoutFrom: lifecycleMocks.restoreExpandedLayoutFrom
}))

vi.mock('./terminal-appearance', () => ({
  applyTerminalAppearance: lifecycleMocks.applyTerminalAppearance,
  installMode2031Handlers: lifecycleMocks.installMode2031Handlers,
  mode2031SequenceFor: lifecycleMocks.mode2031SequenceFor
}))

vi.mock('./osc52-clipboard', () => ({
  parseOsc52: lifecycleMocks.parseOsc52
}))

vi.mock('./parse-osc7', () => ({
  parseOsc7: lifecycleMocks.parseOsc7
}))

vi.mock('./xterm-bypass-policy', () => ({
  shouldBypassXtermKeydown: lifecycleMocks.shouldBypassXtermKeydown
}))

vi.mock('./mouse-hide-while-typing', () => ({
  installMouseHideWhileTyping: lifecycleMocks.installMouseHideWhileTyping
}))

vi.mock('@/lib/terminal-theme', () => ({
  resolveEffectiveTerminalAppearance: vi.fn(() => ({ mode: 'dark' }))
}))

vi.mock('@/runtime/runtime-terminal-stream', () => ({
  getRemoteRuntimePtyEnvironmentId: lifecycleMocks.getRemoteRuntimePtyEnvironmentId
}))

vi.mock('./pane-helpers', () => ({
  fitAndFocusPanes: lifecycleMocks.fitAndFocusPanes,
  fitPanes: lifecycleMocks.fitPanes
}))

vi.mock('@/runtime/sync-runtime-graph', () => ({
  registerRuntimeTerminalTab: lifecycleMocks.registerRuntimeTerminalTab,
  scheduleRuntimeGraphSync: lifecycleMocks.scheduleRuntimeGraphSync
}))

vi.mock('@/lib/e2e-config', () => ({
  e2eConfig: { exposeStore: true }
}))

vi.mock('./replay-guard', () => ({
  isPaneReplaying: vi.fn(() => false)
}))

type ListenerMap = Record<string, ((event: Event) => void)[]>

const listeners: ListenerMap = {}
const writeClipboardText = vi.fn(() => Promise.resolve())

function addWindowListener(type: string, listener: (event: Event) => void): void {
  listeners[type] = [...(listeners[type] ?? []), listener]
}

function removeWindowListener(type: string, listener: (event: Event) => void): void {
  listeners[type] = (listeners[type] ?? []).filter((candidate) => candidate !== listener)
}

function dispatchWindowEvent(type: string, detail: unknown): void {
  for (const listener of listeners[type] ?? []) {
    listener({ detail } as CustomEvent)
  }
}

function makeSettings() {
  return {
    terminalAllowOsc52Clipboard: true,
    terminalClipboardOnSelect: true,
    terminalCursorBlink: false,
    terminalCursorStyle: 'block',
    terminalFontFamily: 'JetBrains Mono',
    terminalFontSize: 15,
    terminalFontWeight: 'normal',
    terminalGpuAcceleration: 'off',
    terminalLineHeight: 1.1,
    terminalMouseHideWhileTyping: true,
    terminalScrollbackBytes: 400_000,
    terminalWordSeparator: ' '
  }
}

function mountLifecycle(overrides: Record<string, unknown> = {}) {
  const settings = makeSettings()
  const managerRef = { current: null }
  const paneTransportsRef = { current: new Map() }
  const deps = {
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    cwd: '/repo/worktree',
    startup: { command: 'start' },
    setupSplit: { command: 'setup', direction: 'vertical' },
    issueCommandSplit: { command: 'issue' },
    isActive: true,
    systemPrefersDark: false,
    settings,
    settingsRef: { current: settings },
    effectiveMacOptionAsAlt: 'false',
    effectiveMacOptionAsAltRef: { current: 'false' },
    initialLayoutRef: {
      current: {
        root: { id: 'leaf-1' },
        activeLeafId: 'leaf-1',
        expandedLeafId: null,
        buffersByLeafId: {},
        ptyIdsByLeafId: { 'leaf-1': 'restored-pty' },
        titlesByLeafId: { 'leaf-1': 'Saved title' }
      }
    },
    managerRef,
    containerRef: { current: {} },
    expandedStyleSnapshotRef: { current: new Map() },
    paneFontSizesRef: { current: new Map() },
    paneTransportsRef,
    paneCwdRef: { current: new Map() },
    paneMode2031Ref: { current: new Map() },
    paneLastThemeModeRef: { current: new Map() },
    panePtyBindingsRef: { current: new Map() },
    replayingPanesRef: { current: new Map() },
    isActiveRef: { current: true },
    isVisibleRef: { current: true },
    onPtyExitRef: { current: vi.fn() },
    clearTabPtyId: vi.fn(),
    consumeSuppressedPtyExit: vi.fn(() => false),
    updateTabTitle: vi.fn(),
    setRuntimePaneTitle: vi.fn(),
    clearRuntimePaneTitle: vi.fn(),
    updateTabPtyId: vi.fn(),
    markWorktreeUnread: vi.fn(),
    markTerminalTabUnread: vi.fn(),
    clearWorktreeUnread: vi.fn(),
    clearTerminalTabUnread: vi.fn(),
    dispatchNotification: vi.fn(),
    setCacheTimerStartedAt: vi.fn(),
    syncPanePtyLayoutBinding: vi.fn(),
    setTabPaneExpanded: vi.fn(),
    setTabCanExpandPane: vi.fn(),
    setExpandedPane: vi.fn(),
    syncExpandedLayout: vi.fn(),
    persistLayoutSnapshot: vi.fn(),
    setPaneTitles: vi.fn(),
    paneTitlesRef: { current: { 2: 'Pane 2' } },
    setRenamingPaneId: vi.fn(),
    setPaneCount: vi.fn(),
    ...overrides
  } as unknown as Parameters<typeof useTerminalPaneLifecycle>[0]

  useTerminalPaneLifecycle(deps)
  return { deps, manager: managerRef.current as never, paneTransportsRef }
}

beforeEach(() => {
  vi.clearAllMocks()
  reactRuntime.cleanups = []
  lifecycleMocks.managers = []
  for (const key of Object.keys(listeners)) {
    delete listeners[key]
  }
  lifecycleMocks.replayTerminalLayout.mockImplementation(
    (manager: { __createPane: () => unknown }) => {
      manager.__createPane()
      return new Map([['leaf-1', 1]])
    }
  )
  lifecycleMocks.connectPanePty.mockImplementation(
    (pane: { id: number }, _manager: unknown, deps) => {
      const transport = {
        destroy: vi.fn(),
        detach: vi.fn(),
        getPtyId: vi.fn(() => `pty-${pane.id}`),
        isConnected: vi.fn(() => true),
        sendInput: vi.fn(() => true)
      }
      deps.paneTransportsRef.current.set(pane.id, transport)
      return { dispose: vi.fn() }
    }
  )
  vi.stubGlobal('navigator', { userAgent: 'Mac OS' })
  vi.stubGlobal('window', {
    __paneManagers: undefined,
    addEventListener: vi.fn(addWindowListener),
    api: {
      ui: { writeClipboardText }
    },
    removeEventListener: vi.fn(removeWindowListener),
    setTimeout: vi.fn()
  })
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  )
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('splitPaneWithOneShotStartup', () => {
  it('clears the one-shot startup payload after success or failure', () => {
    const deps = { startup: null as { command: string } | null }

    expect(splitPaneWithOneShotStartup(deps, { command: 'setup' }, () => ({ id: 1 }))).toEqual({
      id: 1
    })
    expect(deps.startup).toBeNull()

    expect(() =>
      splitPaneWithOneShotStartup(deps, { command: 'setup' }, () => {
        throw new Error('split failed')
      })
    ).toThrow('split failed')
    expect(deps.startup).toBeNull()
  })
})

describe('useTerminalPaneLifecycle', () => {
  it('initializes panes, handles terminal callbacks and CLI events, and cleans up', () => {
    const { deps, manager } = mountLifecycle()
    const typedManager = manager as {
      destroyed: boolean
      getPanes: () => {
        id: number
        linkTooltip: { style: { display: string }; textContent: string }
        oscHandlers: Map<number, (data: string) => boolean>
        selectionCallback: null | (() => void)
        terminal: {
          clearSelection: ReturnType<typeof vi.fn>
          options: {
            linkHandler?: {
              activate: (event: MouseEvent, text: string) => void
              hover: (event: MouseEvent, text: string) => void
              leave: () => void
            }
          }
        }
      }[]
      gpuAcceleration: string | null
      panes: unknown[]
    }
    const firstPane = typedManager.getPanes()[0]

    expect(lifecycleMocks.registerRuntimeTerminalTab).toHaveBeenCalled()
    expect(lifecycleMocks.connectPanePty).toHaveBeenCalled()
    expect(deps.setPaneTitles).toHaveBeenCalled()
    expect(deps.setExpandedPane).toHaveBeenCalledWith(null)
    expect(deps.setTabCanExpandPane).toHaveBeenLastCalledWith('tab-1', true)
    expect(typedManager.gpuAcceleration).toBe('off')
    expect(window.__paneManagers?.get('tab-1')).toBe(typedManager)

    expect(firstPane.oscHandlers.get(52)?.('payload')).toBe(true)
    expect(writeClipboardText).toHaveBeenCalledWith('osc52 text')

    expect(firstPane.oscHandlers.get(7)?.('payload')).toBe(true)
    expect(deps.paneCwdRef.current.get(firstPane.id)).toEqual({
      cwd: '/osc7-cwd',
      confirmed: true
    })

    firstPane.selectionCallback?.()
    expect(writeClipboardText).toHaveBeenCalledWith('selected text')

    firstPane.terminal.options.linkHandler?.hover({} as MouseEvent, 'https://example.test')
    expect(firstPane.linkTooltip.textContent).toBe('https://example.test (open url)')
    firstPane.terminal.options.linkHandler?.leave()
    expect(firstPane.linkTooltip.style.display).toBe('none')
    firstPane.terminal.options.linkHandler?.activate({} as MouseEvent, 'https://example.test')
    expect(lifecycleMocks.handleOscLink).toHaveBeenCalled()
    expect(lifecycleMocks.clearSelection).toHaveBeenCalled()

    dispatchWindowEvent(SPLIT_TERMINAL_PANE_EVENT, {
      command: 'cli split',
      direction: 'horizontal',
      paneRuntimeId: firstPane.id,
      tabId: 'tab-1'
    })
    expect(lifecycleMocks.connectPanePty).toHaveBeenCalled()

    dispatchWindowEvent(CLOSE_TERMINAL_PANE_EVENT, {
      paneRuntimeId: firstPane.id,
      tabId: 'tab-1'
    })
    expect(deps.clearRuntimePaneTitle).toHaveBeenCalledWith('tab-1', firstPane.id)
    expect(lifecycleMocks.dropAgentStatus).toHaveBeenCalledWith(
      `tab-1:${(firstPane as unknown as { leafId: string }).leafId}`
    )

    typedManager.panes = [typedManager.getPanes()[0]]
    dispatchWindowEvent(CLOSE_TERMINAL_PANE_EVENT, {
      paneRuntimeId: typedManager.getPanes()[0]?.id,
      tabId: 'tab-1'
    })
    expect(lifecycleMocks.closeTab).toHaveBeenCalledWith('tab-1')

    for (const cleanup of reactRuntime.cleanups) {
      cleanup()
    }

    expect(window.removeEventListener).toHaveBeenCalledWith(
      SPLIT_TERMINAL_PANE_EVENT,
      expect.any(Function)
    )
    expect(lifecycleMocks.restoreExpandedLayoutFrom).toHaveBeenCalled()
    expect(typedManager.destroyed).toBe(true)
    expect(deps.setTabPaneExpanded).toHaveBeenCalledWith('tab-1', false)
    expect(deps.setTabCanExpandPane).toHaveBeenCalledWith('tab-1', false)
    expect(window.__paneManagers?.has('tab-1')).toBe(false)
  })

  it('skips initialization without a container and toggles mouse-hide disposables later', () => {
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal: {}, container: {} }]),
      setTerminalGpuAcceleration: vi.fn()
    }
    mountLifecycle({
      containerRef: { current: null },
      managerRef: { current: manager },
      settings: { ...makeSettings(), terminalMouseHideWhileTyping: false },
      settingsRef: { current: { ...makeSettings(), terminalMouseHideWhileTyping: false } }
    })

    expect(lifecycleMocks.replayTerminalLayout).not.toHaveBeenCalled()
    expect(manager.setTerminalGpuAcceleration).toHaveBeenCalledWith('off')
  })
})
