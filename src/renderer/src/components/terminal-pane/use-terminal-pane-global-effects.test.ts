/* eslint-disable max-lines -- Why: these hook tests share a mocked React lifecycle harness with global event cases. */
import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import { useTerminalPaneGlobalEffects } from './use-terminal-pane-global-effects'

const mocks = vi.hoisted(() => ({
  captureScrollState: vi.fn(),
  fitAndFocusPanes: vi.fn(),
  fitPanes: vi.fn(),
  flushTerminalOutput: vi.fn(),
  getTerminalOutputEpoch: vi.fn(() => 0),
  handleTerminalFileDrop: vi.fn(),
  getFitOverrideForPty: vi.fn(() => null),
  requestTerminalBacklogRecovery: vi.fn(),
  restoreScrollState: vi.fn(),
  restoreScrollStateAfterLayout: vi.fn(),
  isPtyLocked: vi.fn(() => false),
  isRemoteRuntimePtyId: vi.fn(() => false)
}))

const reactRefState = vi.hoisted(() => ({
  slots: [] as { current: unknown }[],
  index: 0
}))

function beginHookRender(): void {
  reactRefState.index = 0
}

function resetHookRefs(): void {
  reactRefState.slots = []
  reactRefState.index = 0
}

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T extends (...args: never[]) => unknown>(callback: T) => callback,
    useEffect: (effect: () => void | (() => void)) => {
      effect()
    },
    useRef: <T>(value: T) => {
      const index = reactRefState.index
      reactRefState.index += 1
      if (!reactRefState.slots[index]) {
        reactRefState.slots[index] = { current: value }
      }
      return reactRefState.slots[index] as { current: T }
    }
  }
})

vi.mock('./pane-helpers', () => ({
  fitAndFocusPanes: mocks.fitAndFocusPanes,
  fitPanes: mocks.fitPanes
}))

vi.mock('@/lib/pane-manager/pane-terminal-output-scheduler', () => ({
  flushTerminalOutput: mocks.flushTerminalOutput,
  requestTerminalBacklogRecovery: mocks.requestTerminalBacklogRecovery
}))

vi.mock('@/lib/pane-manager/pane-scroll', () => ({
  captureScrollState: mocks.captureScrollState,
  getTerminalOutputEpoch: mocks.getTerminalOutputEpoch,
  restoreScrollState: mocks.restoreScrollState,
  restoreScrollStateAfterLayout: mocks.restoreScrollStateAfterLayout
}))

vi.mock('./terminal-drop-handler', () => ({
  handleTerminalFileDrop: mocks.handleTerminalFileDrop
}))

vi.mock('@/lib/pane-manager/mobile-fit-overrides', () => ({
  getFitOverrideForPty: mocks.getFitOverrideForPty
}))

vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({
  isPtyLocked: mocks.isPtyLocked
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: mocks.isRemoteRuntimePtyId
}))

class MockResizeObserver {
  observe = vi.fn()
  disconnect = vi.fn()
}

type DropCallback = (data: { paths: string[]; target: string; tabId?: string }) => void

function useMountForFileDrop(
  options: {
    tabId?: string
    worktreeId?: string
    cwd?: string
    isActive?: boolean
    isVisible?: boolean
    isSyncFitEnabled?: boolean
    paneCount?: number
  } = {}
): {
  onFileDrop: DropCallback
  manager: {
    getPanes: ReturnType<typeof vi.fn>
    resumeRendering: ReturnType<typeof vi.fn>
    suspendRendering: ReturnType<typeof vi.fn>
    getActivePane: ReturnType<typeof vi.fn>
  }
  paneTransports: Map<number, never>
} {
  let onFileDrop: DropCallback = () => {
    throw new Error('onFileDrop callback was not registered')
  }
  window.api.ui.onFileDrop = vi.fn((callback) => {
    onFileDrop = callback
    return vi.fn()
  })
  const manager = {
    getPanes: vi.fn(() => []),
    resumeRendering: vi.fn(),
    suspendRendering: vi.fn(),
    getActivePane: vi.fn(() => null)
  }
  const paneTransports = new Map<number, never>()

  beginHookRender()
  useTerminalPaneGlobalEffects({
    tabId: options.tabId ?? 'tab-1',
    worktreeId: options.worktreeId ?? 'wt-1',
    cwd: options.cwd,
    isActive: options.isActive ?? true,
    isVisible: options.isVisible ?? true,
    isSyncFitEnabled: options.isSyncFitEnabled ?? options.isVisible ?? true,
    paneCount: options.paneCount ?? 0,
    managerRef: { current: manager as never },
    containerRef: { current: null },
    paneTransportsRef: { current: paneTransports },
    isActiveRef: { current: false },
    isVisibleRef: { current: false },
    toggleExpandPane: vi.fn()
  })

  return { onFileDrop, manager, paneTransports }
}

describe('useTerminalPaneGlobalEffects', () => {
  beforeEach(() => {
    resetHookRefs()
    vi.clearAllMocks()
    vi.useFakeTimers()
    ;(globalThis as unknown as { window: unknown }).window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      api: {
        ui: {
          onFileDrop: vi.fn(() => vi.fn())
        },
        pty: {
          resize: vi.fn(),
          resizeAndSignal: vi.fn(() => Promise.resolve(true)),
          signal: vi.fn()
        }
      }
    }
    ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = MockResizeObserver
    ;(globalThis as unknown as { requestAnimationFrame: unknown }).requestAnimationFrame = vi.fn(
      () => 1
    )
    ;(globalThis as unknown as { cancelAnimationFrame: unknown }).cancelAnimationFrame = vi.fn()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    delete (globalThis as unknown as { window?: unknown }).window
    delete (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver
    delete (globalThis as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame
    delete (globalThis as unknown as { cancelAnimationFrame?: unknown }).cancelAnimationFrame
  })

  it('flushes visible terminal panes before resuming rendering and fitting', () => {
    const order: string[] = []
    const terminalA = { name: 'terminal-a' }
    const terminalB = { name: 'terminal-b' }
    const manager = {
      getPanes: vi.fn(() => [
        { id: 1, terminal: terminalA },
        { id: 2, terminal: terminalB }
      ]),
      resumeRendering: vi.fn(() => order.push('resume')),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    mocks.flushTerminalOutput.mockImplementation((terminal: { name: string }) => {
      order.push(`flush:${terminal.name}`)
    })
    mocks.requestTerminalBacklogRecovery.mockImplementation((terminal: { name: string }) => {
      order.push(`recover:${terminal.name}`)
    })
    mocks.captureScrollState.mockImplementation((terminal: { name: string }) => {
      order.push(`capture:${terminal.name}`)
      return { terminalName: terminal.name }
    })
    mocks.restoreScrollStateAfterLayout.mockImplementation((terminal: { name: string }) => {
      order.push(`restore:${terminal.name}`)
    })
    mocks.fitAndFocusPanes.mockImplementation(() => order.push('fit-focus'))

    const isActiveRef = { current: false }
    const isVisibleRef = { current: false }
    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: true,
      isVisible: true,
      isSyncFitEnabled: true,
      paneCount: 2,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef,
      isVisibleRef,
      toggleExpandPane: vi.fn()
    })

    expect(order).toEqual([
      'capture:terminal-a',
      'capture:terminal-b',
      'recover:terminal-a',
      'flush:terminal-a',
      'recover:terminal-b',
      'flush:terminal-b',
      'resume',
      'fit-focus',
      'restore:terminal-a',
      'restore:terminal-b'
    ])
    expect(mocks.flushTerminalOutput).toHaveBeenNthCalledWith(1, terminalA, {
      maxChars: 256 * 1024
    })
    expect(mocks.flushTerminalOutput).toHaveBeenNthCalledWith(2, terminalB, {
      maxChars: 256 * 1024
    })
    expect(mocks.fitPanes).not.toHaveBeenCalled()
    expect(isActiveRef.current).toBe(true)
    expect(isVisibleRef.current).toBe(true)
  })

  it('restores from the pre-hide scroll state when hidden layout changes the viewport', () => {
    const terminalA = { name: 'terminal-a' }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal: terminalA }]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    const initialState = { marker: 'initial' }
    const preHideState = { marker: 'before-hide' }
    const corruptedHiddenState = { marker: 'hidden-corrupted' }
    let nextCapturedState = initialState
    mocks.captureScrollState.mockImplementation(() => nextCapturedState)

    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    nextCapturedState = preHideState
    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false
    })

    nextCapturedState = corruptedHiddenState
    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    expect(mocks.captureScrollState).toHaveBeenCalledTimes(2)
    expect(manager.suspendRendering).toHaveBeenCalledTimes(1)
    expect(mocks.restoreScrollStateAfterLayout).toHaveBeenLastCalledWith(terminalA, preHideState)
  })

  it('refreshes and pulses resized PTYs when hidden panes become visible again', () => {
    const terminal = {
      name: 'terminal-a',
      cols: 80,
      rows: 24,
      refresh: vi.fn()
    }
    const transport = {
      resize: vi.fn(() => true),
      getPtyId: vi.fn(() => 'pty-1')
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    const paneTransports = new Map([[1, transport]])
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: paneTransports as never },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false
    })

    terminal.cols = 120
    terminal.rows = 30
    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    expect(terminal.refresh).toHaveBeenCalledWith(0, 29)
    expect(transport.resize).not.toHaveBeenCalled()
    expect(window.api.pty.resizeAndSignal).toHaveBeenCalledWith('pty-1', 120, 30, 'SIGWINCH')
    expect(window.api.pty.signal).not.toHaveBeenCalled()
  })

  it('reconciles again after hidden resume layout settles', () => {
    const terminal = {
      name: 'terminal-a',
      cols: 80,
      rows: 24,
      refresh: vi.fn()
    }
    const transport = {
      resize: vi.fn(() => true),
      getPtyId: vi.fn(() => 'pty-1')
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map([[1, transport]]) as never },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false
    })

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })
    expect(window.api.pty.resizeAndSignal).not.toHaveBeenCalled()

    terminal.cols = 120
    terminal.rows = 30
    vi.advanceTimersByTime(250)

    expect(window.api.pty.resizeAndSignal).toHaveBeenCalledWith('pty-1', 120, 30, 'SIGWINCH')
  })

  it('matches hidden sizes by PTY when pane numeric ids change while hidden', () => {
    const terminal = {
      name: 'terminal-a',
      cols: 80,
      rows: 24,
      refresh: vi.fn()
    }
    let paneId = 1
    const transport = {
      resize: vi.fn(() => true),
      getPtyId: vi.fn(() => 'pty-1')
    }
    const manager = {
      getPanes: vi.fn(() => [
        {
          id: paneId,
          terminal,
          container: { dataset: { ptyId: 'pty-1' } }
        }
      ]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map([[1, transport]]) as never },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false
    })

    paneId = 2
    terminal.cols = 120
    terminal.rows = 30
    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    expect(terminal.refresh).toHaveBeenCalledWith(0, 29)
    expect(transport.resize).not.toHaveBeenCalled()
    expect(window.api.pty.resizeAndSignal).toHaveBeenCalledWith('pty-1', 120, 30, 'SIGWINCH')
    expect(window.api.pty.signal).not.toHaveBeenCalled()
  })

  it('falls back to the DOM PTY id when a pane keeps a stale disconnected transport', () => {
    const terminal = {
      name: 'terminal-a',
      cols: 80,
      rows: 24,
      refresh: vi.fn()
    }
    const staleTransport = {
      resize: vi.fn(() => false),
      getPtyId: vi.fn(() => null)
    }
    const manager = {
      getPanes: vi.fn(() => [
        {
          id: 1,
          terminal,
          container: { dataset: { ptyId: 'pty-1' } }
        }
      ]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map([[1, staleTransport]]) as never },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false
    })

    terminal.cols = 120
    terminal.rows = 30
    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    expect(staleTransport.resize).not.toHaveBeenCalled()
    expect(window.api.pty.resizeAndSignal).toHaveBeenCalledWith('pty-1', 120, 30, 'SIGWINCH')
    expect(window.api.pty.signal).not.toHaveBeenCalled()
  })

  it('does not pulse resized hidden panes while mobile owns the PTY', () => {
    mocks.isPtyLocked.mockReturnValueOnce(true)
    const terminal = {
      name: 'terminal-a',
      cols: 80,
      rows: 24,
      refresh: vi.fn()
    }
    const transport = {
      resize: vi.fn(),
      getPtyId: vi.fn(() => 'pty-1')
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map([[1, transport]]) as never },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false
    })

    terminal.cols = 120
    terminal.rows = 30
    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    expect(terminal.refresh).toHaveBeenCalledWith(0, 29)
    expect(transport.resize).not.toHaveBeenCalled()
    expect(window.api.pty.resizeAndSignal).not.toHaveBeenCalled()
    expect(window.api.pty.signal).not.toHaveBeenCalled()
  })

  it('resizes remote runtime panes without local PTY signaling', () => {
    mocks.isRemoteRuntimePtyId.mockReturnValueOnce(true)
    const terminal = {
      name: 'terminal-a',
      cols: 80,
      rows: 24,
      refresh: vi.fn()
    }
    const transport = {
      resize: vi.fn(() => true),
      getPtyId: vi.fn(() => 'runtime:pty-1')
    }
    const manager = {
      getPanes: vi.fn(() => [{ id: 1, terminal }]),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null),
      setActivePane: vi.fn()
    }
    const baseArgs = {
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map([[1, transport]]) as never },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      paneCount: 1,
      isSyncFitEnabled: true,
      toggleExpandPane: vi.fn()
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: false,
      isVisible: false
    })

    terminal.cols = 120
    terminal.rows = 30
    beginHookRender()
    useTerminalPaneGlobalEffects({
      ...baseArgs,
      isActive: true,
      isVisible: true
    })

    expect(terminal.refresh).toHaveBeenCalledWith(0, 29)
    expect(transport.resize).toHaveBeenCalledWith(120, 30)
    expect(window.api.pty.resizeAndSignal).not.toHaveBeenCalled()
    expect(window.api.pty.signal).not.toHaveBeenCalled()
  })

  it('ignores terminal file drops for another terminal tab', () => {
    const { onFileDrop } = useMountForFileDrop()

    onFileDrop({ paths: ['/tmp/image.png'], target: 'terminal', tabId: 'tab-2' })

    expect(mocks.handleTerminalFileDrop).not.toHaveBeenCalled()
  })

  it('handles terminal file drops for the matching terminal tab', () => {
    const { onFileDrop, manager, paneTransports } = useMountForFileDrop({
      cwd: '/worktree'
    })

    const data = { paths: ['/tmp/image.png'], target: 'terminal', tabId: 'tab-1' }
    onFileDrop(data)

    expect(mocks.handleTerminalFileDrop).toHaveBeenCalledWith({
      manager,
      paneTransports,
      worktreeId: 'wt-1',
      cwd: '/worktree',
      data
    })
  })

  it('keeps handling legacy terminal file drops without a terminal tab id', () => {
    const { onFileDrop, manager, paneTransports } = useMountForFileDrop()

    const data = { paths: ['/tmp/image.png'], target: 'terminal' }
    onFileDrop(data)

    expect(mocks.handleTerminalFileDrop).toHaveBeenCalledWith({
      manager,
      paneTransports,
      worktreeId: 'wt-1',
      cwd: undefined,
      data
    })
  })

  it('handles terminal file drops for visible unfocused split-group terminals', () => {
    const { onFileDrop } = useMountForFileDrop({ isActive: false, isVisible: true })

    onFileDrop({ paths: ['/tmp/image.png'], target: 'terminal', tabId: 'tab-1' })

    expect(mocks.handleTerminalFileDrop).toHaveBeenCalledTimes(1)
  })

  it('ignores legacy terminal file drops in visible unfocused split-group terminals', () => {
    const { onFileDrop } = useMountForFileDrop({ isActive: false, isVisible: true })

    onFileDrop({ paths: ['/tmp/image.png'], target: 'terminal' })

    expect(mocks.handleTerminalFileDrop).not.toHaveBeenCalled()
  })

  it('skips global sync-fit registration for hidden non-measurable terminal panes', () => {
    const manager = {
      getPanes: vi.fn(() => []),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null)
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: false,
      isVisible: false,
      isSyncFitEnabled: false,
      paneCount: 0,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const syncFitListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === SYNC_FIT_PANES_EVENT)

    expect(syncFitListener).toBeUndefined()
  })

  it('registers global sync-fit for measurable hidden startup panes', () => {
    const manager = {
      getPanes: vi.fn(() => []),
      resumeRendering: vi.fn(),
      suspendRendering: vi.fn(),
      fitAllPanes: vi.fn(),
      getActivePane: vi.fn(() => null)
    }

    beginHookRender()
    useTerminalPaneGlobalEffects({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      isActive: false,
      isVisible: false,
      isSyncFitEnabled: true,
      paneCount: 0,
      managerRef: { current: manager as never },
      containerRef: { current: null },
      paneTransportsRef: { current: new Map() },
      isActiveRef: { current: false },
      isVisibleRef: { current: false },
      toggleExpandPane: vi.fn()
    })

    const syncFitListener = vi
      .mocked(window.addEventListener)
      .mock.calls.find(([eventName]) => eventName === SYNC_FIT_PANES_EVENT)

    expect(syncFitListener).toBeDefined()
    const listener = syncFitListener?.[1]
    if (typeof listener !== 'function') {
      throw new Error('expected sync-fit listener')
    }
    listener(new Event(SYNC_FIT_PANES_EVENT))
    expect(manager.fitAllPanes).toHaveBeenCalledTimes(1)
  })
})
