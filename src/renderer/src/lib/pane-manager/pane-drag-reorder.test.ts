import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import { attachPaneDrag, createDragReorderState } from './pane-drag-reorder'
import type { TerminalLeafId } from '../../../../shared/stable-pane-id'

const detachPaneFromTree = vi.hoisted(() => vi.fn())
const insertPaneNextTo = vi.hoisted(() => vi.fn())

vi.mock('./pane-tree-ops', () => ({
  detachPaneFromTree,
  insertPaneNextTo
}))

type FakeListener = (event: PointerEvent) => void

class FakeClassList {
  private readonly values = new Set<string>()

  constructor(initial: readonly string[] = []) {
    for (const value of initial) {
      this.values.add(value)
    }
  }

  add(value: string): void {
    this.values.add(value)
  }

  remove(...values: string[]): void {
    for (const value of values) {
      this.values.delete(value)
    }
  }

  contains(value: string): boolean {
    return this.values.has(value)
  }
}

class FakeElement {
  readonly classList: FakeClassList
  readonly style: Record<string, string> = {}
  readonly dataset: Record<string, string> = {}
  private readonly listeners = new Map<string, Set<FakeListener>>()
  private readonly capturedPointerIds = new Set<number>()
  removed = false

  constructor(
    classNames: readonly string[] = [],
    private readonly rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    private readonly children: FakeElement[] = []
  ) {
    this.classList = new FakeClassList(classNames)
  }

  addEventListener(type: string, listener: FakeListener): void {
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  listenerCount(type: string): number {
    return this.listeners.get(type)?.size ?? 0
  }

  dispatchPointer(type: string, event: Partial<PointerEvent>): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event as PointerEvent)
    }
  }

  setPointerCapture(pointerId: number): void {
    this.capturedPointerIds.add(pointerId)
  }

  releasePointerCapture(pointerId: number): void {
    this.capturedPointerIds.delete(pointerId)
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.capturedPointerIds.has(pointerId)
  }

  getBoundingClientRect(): DOMRect {
    return this.rect as DOMRect
  }

  closest(selector: string): FakeElement | null {
    if (selector.includes('[data-pane-drop-new-tab-target="true"]')) {
      return this.dataset.paneDropNewTabTarget === 'true' ? this : null
    }
    if (selector.includes('.terminal-tab-strip')) {
      return this.classList.contains('terminal-tab-strip') ? this : null
    }
    return null
  }

  querySelectorAll(): FakeElement[] {
    return this.children
  }

  remove(): void {
    this.removed = true
  }
}

function pointerEvent(args: Partial<PointerEvent>): PointerEvent {
  return {
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    pointerId: 1,
    clientX: 0,
    clientY: 0,
    ...args
  } as unknown as PointerEvent
}

function createPane(id: number, container: FakeElement): ManagedPaneInternal {
  const leafId =
    `${id}${id}${id}${id}${id}${id}${id}${id}-${id}${id}${id}${id}-4${id}${id}${id}-8${id}${id}${id}-${id}${id}${id}${id}${id}${id}${id}${id}${id}${id}${id}${id}` as TerminalLeafId
  container.dataset.paneId = String(id)
  container.dataset.leafId = leafId
  return {
    id,
    leafId,
    stablePaneId: leafId,
    terminal: {} as never,
    container: container as unknown as HTMLElement,
    xtermContainer: {} as never,
    linkTooltip: {} as never,
    terminalGpuAcceleration: 'auto',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: null,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    fitAddon: {} as never,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

describe('attachPaneDrag', () => {
  let appendedElements: FakeElement[]

  beforeEach(() => {
    vi.clearAllMocks()
    appendedElements = []
    vi.stubGlobal('document', {
      createElement: () => new FakeElement(['pane-drop-overlay']),
      querySelectorAll: () => [],
      body: {
        appendChild: (element: FakeElement) => {
          appendedElements.push(element)
        }
      }
    })
    vi.stubGlobal('window', {
      scrollX: 0,
      scrollY: 0,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('cleans pane drag state when pointer capture is cancelled', () => {
    const handle = new FakeElement()
    const root = new FakeElement(['pane-manager-root'])
    const sourceContainer = new FakeElement(['pane'], {
      left: 0,
      top: 0,
      right: 100,
      bottom: 100,
      width: 100,
      height: 100
    })
    const targetContainer = new FakeElement(['pane'], {
      left: 0,
      top: 100,
      right: 100,
      bottom: 200,
      width: 100,
      height: 100
    })
    const sourcePane = createPane(1, sourceContainer)
    const targetPane = createPane(2, targetContainer)
    const panes = new Map<number, ManagedPaneInternal>([
      [sourcePane.id, sourcePane],
      [targetPane.id, targetPane]
    ])
    const onDragActiveChange = vi.fn()
    const state = createDragReorderState()

    attachPaneDrag(handle as unknown as HTMLElement, sourcePane.id, state, {
      getPanes: () => panes,
      getRoot: () => root as unknown as HTMLElement,
      getStyleOptions: () => ({}),
      isDestroyed: () => false,
      safeFit: vi.fn(),
      applyPaneOpacity: vi.fn(),
      applyDividerStyles: vi.fn(),
      refitPanesUnder: vi.fn(),
      onDragActiveChange
    })

    handle.dispatchPointer('pointerdown', pointerEvent({ clientX: 10, clientY: 10 }))
    handle.dispatchPointer('pointermove', pointerEvent({ clientX: 50, clientY: 150 }))

    expect(root.classList.contains('is-pane-dragging')).toBe(true)
    expect(sourceContainer.classList.contains('is-drag-source')).toBe(true)
    expect(state.currentDropTarget).toEqual({ type: 'pane', paneId: targetPane.id, zone: 'top' })
    expect(appendedElements).toHaveLength(1)
    expect(onDragActiveChange).toHaveBeenCalledWith(true)

    handle.dispatchPointer('pointercancel', pointerEvent({ pointerId: 1 }))

    expect(root.classList.contains('is-pane-dragging')).toBe(false)
    expect(sourceContainer.classList.contains('is-drag-source')).toBe(false)
    expect(appendedElements[0].removed).toBe(true)
    expect(state.dragSourcePaneId).toBeNull()
    expect(state.currentDropTarget).toBeNull()
    expect(state.cleanupActiveDrag).toBeNull()
    expect(onDragActiveChange).toHaveBeenLastCalledWith(false)
    expect(detachPaneFromTree).not.toHaveBeenCalled()
    expect(insertPaneNextTo).not.toHaveBeenCalled()
  })

  it('drops a pane as a new tab when released over empty terminal surface', () => {
    const handle = new FakeElement()
    const root = new FakeElement(['pane-manager-root'], {
      left: 0,
      top: 0,
      right: 240,
      bottom: 180,
      width: 240,
      height: 180
    })
    const sourceContainer = new FakeElement(['pane'], {
      left: 0,
      top: 0,
      right: 100,
      bottom: 180,
      width: 100,
      height: 180
    })
    const targetContainer = new FakeElement(['pane'], {
      left: 100,
      top: 0,
      right: 200,
      bottom: 180,
      width: 100,
      height: 180
    })
    const sourcePane = createPane(1, sourceContainer)
    const targetPane = createPane(2, targetContainer)
    const panes = new Map<number, ManagedPaneInternal>([
      [sourcePane.id, sourcePane],
      [targetPane.id, targetPane]
    ])
    const onPaneDropAsNewTab = vi.fn(() => true)
    const state = createDragReorderState()

    attachPaneDrag(handle as unknown as HTMLElement, sourcePane.id, state, {
      getPanes: () => panes,
      getRoot: () => root as unknown as HTMLElement,
      getStyleOptions: () => ({}),
      isDestroyed: () => false,
      safeFit: vi.fn(),
      applyPaneOpacity: vi.fn(),
      applyDividerStyles: vi.fn(),
      refitPanesUnder: vi.fn(),
      onPaneDropAsNewTab
    })

    handle.dispatchPointer('pointerdown', pointerEvent({ clientX: 10, clientY: 10 }))
    handle.dispatchPointer('pointermove', pointerEvent({ clientX: 220, clientY: 80 }))

    expect(state.currentDropTarget).toEqual({ type: 'new-tab' })
    expect(appendedElements[0].style.height).toBe('28px')

    handle.dispatchPointer('pointerup', pointerEvent({ pointerId: 1 }))

    expect(onPaneDropAsNewTab).toHaveBeenCalledWith(sourcePane, undefined)
    expect(detachPaneFromTree).not.toHaveBeenCalled()
    expect(insertPaneNextTo).not.toHaveBeenCalled()
    expect(state.currentDropTarget).toBeNull()
  })

  it('drops a pane as a new tab when released over the tab bar', () => {
    const handle = new FakeElement()
    const root = new FakeElement(['pane-manager-root'], {
      left: 0,
      top: 40,
      right: 240,
      bottom: 180,
      width: 240,
      height: 140
    })
    const firstTab = new FakeElement([], {
      left: 0,
      top: 0,
      right: 80,
      bottom: 32,
      width: 80,
      height: 32
    })
    firstTab.dataset.unifiedTabId = 'tab-1'
    const secondTab = new FakeElement([], {
      left: 80,
      top: 0,
      right: 160,
      bottom: 32,
      width: 80,
      height: 32
    })
    secondTab.dataset.unifiedTabId = 'tab-2'
    const tabBar = new FakeElement(
      ['terminal-tab-strip'],
      {
        left: 0,
        top: 0,
        right: 240,
        bottom: 32,
        width: 240,
        height: 32
      },
      [firstTab, secondTab]
    )
    tabBar.dataset.paneDropNewTabTarget = 'true'
    tabBar.dataset.paneDropNewTabGroupId = 'group-1'
    const sourceContainer = new FakeElement(['pane'], {
      left: 0,
      top: 40,
      right: 100,
      bottom: 180,
      width: 100,
      height: 140
    })
    const targetContainer = new FakeElement(['pane'], {
      left: 100,
      top: 40,
      right: 200,
      bottom: 180,
      width: 100,
      height: 140
    })
    const sourcePane = createPane(1, sourceContainer)
    const targetPane = createPane(2, targetContainer)
    const panes = new Map<number, ManagedPaneInternal>([
      [sourcePane.id, sourcePane],
      [targetPane.id, targetPane]
    ])
    const onPaneDropAsNewTab = vi.fn(() => true)
    const state = createDragReorderState()
    vi.stubGlobal('document', {
      createElement: () => new FakeElement(['pane-drop-overlay']),
      elementFromPoint: () => tabBar,
      querySelectorAll: () => [firstTab, secondTab],
      body: {
        appendChild: (element: FakeElement) => {
          appendedElements.push(element)
        }
      }
    })

    attachPaneDrag(handle as unknown as HTMLElement, sourcePane.id, state, {
      getPanes: () => panes,
      getRoot: () => root as unknown as HTMLElement,
      getStyleOptions: () => ({}),
      isDestroyed: () => false,
      safeFit: vi.fn(),
      applyPaneOpacity: vi.fn(),
      applyDividerStyles: vi.fn(),
      refitPanesUnder: vi.fn(),
      onPaneDropAsNewTab
    })

    handle.dispatchPointer('pointerdown', pointerEvent({ clientX: 10, clientY: 50 }))
    handle.dispatchPointer('pointermove', pointerEvent({ clientX: 100, clientY: 16 }))

    expect(state.currentDropTarget).toEqual({
      type: 'new-tab',
      placement: { groupId: 'group-1', targetUnifiedTabId: 'tab-2', side: 'left' }
    })
    expect(appendedElements[0].style.display).toBe('none')
    expect(firstTab.classList.contains('pane-tab-drop-after')).toBe(true)
    expect(secondTab.classList.contains('pane-tab-drop-before')).toBe(true)

    handle.dispatchPointer('pointerup', pointerEvent({ pointerId: 1 }))

    expect(onPaneDropAsNewTab).toHaveBeenCalledWith(sourcePane, {
      groupId: 'group-1',
      targetUnifiedTabId: 'tab-2',
      side: 'left'
    })
    expect(firstTab.classList.contains('pane-tab-drop-after')).toBe(false)
    expect(secondTab.classList.contains('pane-tab-drop-before')).toBe(false)
    expect(detachPaneFromTree).not.toHaveBeenCalled()
    expect(insertPaneNextTo).not.toHaveBeenCalled()
    expect(state.currentDropTarget).toBeNull()
  })

  it('returns cleanup that removes handle listeners and cancels active drag capture', () => {
    const handle = new FakeElement()
    const root = new FakeElement(['pane-manager-root'])
    const sourceContainer = new FakeElement(['pane'])
    const targetContainer = new FakeElement(['pane'])
    const sourcePane = createPane(1, sourceContainer)
    const targetPane = createPane(2, targetContainer)
    const panes = new Map<number, ManagedPaneInternal>([
      [sourcePane.id, sourcePane],
      [targetPane.id, targetPane]
    ])
    const state = createDragReorderState()

    const cleanup = attachPaneDrag(handle as unknown as HTMLElement, sourcePane.id, state, {
      getPanes: () => panes,
      getRoot: () => root as unknown as HTMLElement,
      getStyleOptions: () => ({}),
      isDestroyed: () => false,
      safeFit: vi.fn(),
      applyPaneOpacity: vi.fn(),
      applyDividerStyles: vi.fn(),
      refitPanesUnder: vi.fn()
    })

    expect(handle.listenerCount('pointerdown')).toBe(1)
    handle.dispatchPointer('pointerdown', pointerEvent({ pointerId: 1 }))
    expect(state.cleanupActiveDrag).toBeTypeOf('function')
    expect(handle.hasPointerCapture(1)).toBe(true)

    cleanup()

    expect(handle.listenerCount('pointerdown')).toBe(0)
    expect(handle.listenerCount('pointermove')).toBe(0)
    expect(handle.listenerCount('pointerup')).toBe(0)
    expect(handle.listenerCount('pointercancel')).toBe(0)
    expect(handle.listenerCount('lostpointercapture')).toBe(0)
    expect(handle.hasPointerCapture(1)).toBe(false)
    expect(state.cleanupActiveDrag).toBeNull()
    expect(window.removeEventListener).toHaveBeenCalledWith('blur', expect.any(Function), true)
  })
})
