import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PaneManager } from './pane-manager'

const mocks = vi.hoisted(() => ({
  applyDividerStyles: vi.fn(),
  applyPaneOpacity: vi.fn(),
  applyRootBackground: vi.fn(),
  applyTerminalGpuAcceleration: vi.fn(),
  captureScrollState: vi.fn(() => ({ viewportY: 3 })),
  createDivider: vi.fn(() => ({ className: 'divider' })),
  createPaneDOM: vi.fn(),
  disposePane: vi.fn((pane: { id: number }, panes: Map<number, unknown>) => {
    panes.delete(pane.id)
  }),
  disposeWebgl: vi.fn(),
  fitAllPanesInternal: vi.fn(),
  handlePaneDrop: vi.fn(),
  hideDropOverlay: vi.fn(),
  markPaneComplexScriptOutput: vi.fn(),
  openTerminal: vi.fn(),
  reattachWebglIfNeeded: vi.fn(),
  removeDividers: vi.fn(),
  resumePaneRendering: vi.fn(),
  safeFit: vi.fn(),
  scheduleSplitScrollRestore: vi.fn(),
  setLigaturesEnabled: vi.fn(),
  setPaneGpuRenderingState: vi.fn(),
  shouldFollowMouseFocus: vi.fn(() => true),
  suspendPaneRendering: vi.fn(),
  updateMultiPaneState: vi.fn(),
  wrapInSplit: vi.fn()
}))

vi.mock('./pane-divider', () => ({
  applyDividerStyles: mocks.applyDividerStyles,
  applyPaneOpacity: mocks.applyPaneOpacity,
  applyRootBackground: mocks.applyRootBackground,
  createDivider: mocks.createDivider
}))

vi.mock('./pane-drag-reorder', () => ({
  createDragReorderState: vi.fn(() => ({ overlay: null })),
  handlePaneDrop: mocks.handlePaneDrop,
  hideDropOverlay: mocks.hideDropOverlay,
  updateMultiPaneState: mocks.updateMultiPaneState
}))

vi.mock('./pane-lifecycle', () => ({
  createPaneDOM: mocks.createPaneDOM,
  disposePane: mocks.disposePane,
  openTerminal: mocks.openTerminal,
  setLigaturesEnabled: mocks.setLigaturesEnabled
}))

vi.mock('./pane-webgl-renderer', () => ({
  disposeWebgl: mocks.disposeWebgl
}))

vi.mock('./focus-follows-mouse', () => ({
  shouldFollowMouseFocus: mocks.shouldFollowMouseFocus
}))

vi.mock('./pane-tree-ops', () => ({
  captureScrollState: mocks.captureScrollState,
  findPaneChildren: vi.fn(() => []),
  fitAllPanesInternal: mocks.fitAllPanesInternal,
  promoteSibling: vi.fn(),
  refitPanesUnder: vi.fn(),
  removeDividers: mocks.removeDividers,
  safeFit: mocks.safeFit,
  wrapInSplit: mocks.wrapInSplit
}))

vi.mock('./pane-split-scroll', () => ({
  scheduleSplitScrollRestore: mocks.scheduleSplitScrollRestore
}))

vi.mock('./pane-terminal-gpu-acceleration', () => ({
  applyTerminalGpuAcceleration: mocks.applyTerminalGpuAcceleration
}))

vi.mock('./pane-rendering-control', () => ({
  markPaneComplexScriptOutput: mocks.markPaneComplexScriptOutput,
  resumePaneRendering: mocks.resumePaneRendering,
  setPaneGpuRenderingState: mocks.setPaneGpuRenderingState,
  suspendPaneRendering: mocks.suspendPaneRendering
}))

vi.mock('./pane-webgl-reattach', () => ({
  reattachWebglIfNeeded: mocks.reattachWebglIfNeeded
}))

type FakeContainer = {
  classList: { contains: ReturnType<typeof vi.fn> }
  parentElement: FakeRoot | FakeContainer | null
  remove: ReturnType<typeof vi.fn>
  style: Record<string, string>
}

type FakeRoot = {
  appendChild: ReturnType<typeof vi.fn>
  classList: { contains: ReturnType<typeof vi.fn> }
  innerHTML: string
  style: Record<string, string>
}

function makeContainer(): FakeContainer {
  const container: FakeContainer = {
    classList: { contains: vi.fn(() => false) },
    parentElement: null,
    remove: vi.fn(() => {
      container.parentElement = null
    }),
    style: {}
  }
  return container
}

function makeRoot(): FakeRoot {
  const root: FakeRoot = {
    appendChild: vi.fn((child: FakeContainer) => {
      child.parentElement = root
    }),
    classList: { contains: vi.fn(() => false) },
    innerHTML: '',
    style: {}
  }
  return root
}

function makePane(id: number) {
  return {
    id,
    container: makeContainer(),
    fitAddon: { fit: vi.fn() },
    pendingSplitScrollState: null,
    terminal: { focus: vi.fn() },
    webglAddon: null as unknown
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createPaneDOM.mockImplementation(
    (id: number, _leafId, _options, _dragState, _callbacks, onPointerDown, onMouseEnter) => {
      const pane = makePane(id)
      ;(
        pane as unknown as { onPointerDown: () => void; onMouseEnter: (event: MouseEvent) => void }
      ).onPointerDown = () => onPointerDown(id)
      ;(
        pane as unknown as { onPointerDown: () => void; onMouseEnter: (event: MouseEvent) => void }
      ).onMouseEnter = (event: MouseEvent) => onMouseEnter(id, event)
      return pane
    }
  )
  mocks.wrapInSplit.mockImplementation(
    (existing: FakeContainer, next: FakeContainer, _vertical: boolean, _divider, _opts) => {
      next.parentElement = existing.parentElement
    }
  )
  vi.stubGlobal('document', { hasFocus: vi.fn(() => true) })
})

describe('PaneManager', () => {
  it('creates, splits, focuses, styles, moves, and closes panes', () => {
    const root = makeRoot()
    const onPaneCreated = vi.fn()
    const onPaneClosed = vi.fn()
    const onActivePaneChange = vi.fn()
    const onLayoutChanged = vi.fn()
    const manager = new PaneManager(root as unknown as HTMLElement, {
      onActivePaneChange,
      onLayoutChanged,
      onPaneClosed,
      onPaneCreated,
      terminalGpuAcceleration: 'auto'
    })

    const first = manager.createInitialPane()
    expect(first.id).toBe(1)
    expect(root.appendChild).toHaveBeenCalled()
    expect(mocks.openTerminal).toHaveBeenCalled()
    expect(first.terminal.focus).toHaveBeenCalled()
    expect(onPaneCreated).toHaveBeenCalledWith(first, undefined)
    expect(manager.getActivePane()?.id).toBe(first.id)

    expect(manager.splitPane(999, 'vertical')).toBeNull()
    const second = manager.splitPane(first.id, 'vertical', { cwd: '/repo', ratio: 0.4 })

    expect(second?.id).toBe(2)
    expect(mocks.captureScrollState).toHaveBeenCalled()
    expect(mocks.wrapInSplit).toHaveBeenCalled()
    expect(onPaneCreated).toHaveBeenLastCalledWith(second, { cwd: '/repo' })
    expect(onLayoutChanged).toHaveBeenCalled()
    expect(manager.getActivePane()?.id).toBe(second?.id)

    manager.setActivePane(first.id, { focus: false })
    expect(onActivePaneChange).toHaveBeenCalledWith(first)
    manager.setActivePane(999)
    expect(manager.getActivePane()?.id).toBe(first.id)

    manager.setPaneStyleOptions({ inactivePaneOpacity: 0.5, focusFollowsMouse: true })
    expect(mocks.applyRootBackground).toHaveBeenCalledWith(root, {
      inactivePaneOpacity: 0.5,
      focusFollowsMouse: true
    })

    manager.setPaneLigaturesEnabled(first.id, true)
    manager.setPaneGpuRendering(first.id, false)
    manager.setTerminalGpuAcceleration('off')
    manager.markPaneHasComplexScriptOutput(first.id)
    manager.suspendRendering()
    manager.resumeRendering()
    manager.fitAllPanes()
    manager.movePane(first.id, second?.id ?? 2, 'right')

    expect(mocks.setLigaturesEnabled).toHaveBeenCalled()
    expect(mocks.setPaneGpuRenderingState).toHaveBeenCalled()
    expect(mocks.applyTerminalGpuAcceleration).toHaveBeenCalled()
    expect(mocks.markPaneComplexScriptOutput).toHaveBeenCalled()
    expect(mocks.suspendPaneRendering).toHaveBeenCalled()
    expect(mocks.resumePaneRendering).toHaveBeenCalled()
    expect(mocks.fitAllPanesInternal).toHaveBeenCalled()
    expect(mocks.handlePaneDrop).toHaveBeenCalled()

    const internalFirst = mocks.createPaneDOM.mock.results[0]?.value as {
      onMouseEnter: (event: MouseEvent) => void
    }
    internalFirst.onMouseEnter({ buttons: 0 } as MouseEvent)
    expect(mocks.shouldFollowMouseFocus).toHaveBeenCalledWith(
      expect.objectContaining({
        activePaneId: first.id,
        hoveredPaneId: first.id,
        windowHasFocus: true
      })
    )

    manager.closePane(second?.id ?? 2)
    expect(mocks.disposePane).toHaveBeenCalled()
    expect(onPaneClosed).toHaveBeenCalledWith(
      second?.id,
      expect.objectContaining({ paneId: second?.id })
    )
    expect(manager.getPanes()).toHaveLength(1)
  })

  it('skips focus when requested and cleans everything up on destroy', () => {
    const root = makeRoot()
    const manager = new PaneManager(root as unknown as HTMLElement, {})

    const pane = manager.createInitialPane({ focus: false })
    expect(pane.terminal.focus).not.toHaveBeenCalled()

    manager.destroy()

    expect(mocks.hideDropOverlay).toHaveBeenCalled()
    expect(mocks.disposePane).toHaveBeenCalled()
    expect(root.innerHTML).toBe('')
    expect(manager.getActivePane()).toBeNull()
    expect(manager.getPanes()).toEqual([])
  })
})
