// @ts-nocheck -- Fake DOM tree implements only the pane-manager APIs under test.
/* eslint-disable max-lines -- Why: fake DOM pane-manager coverage keeps split,
   drag, divider, and cleanup fixtures in one intentionally partial harness. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'
import {
  applyDividerStyles,
  applyPaneOpacity,
  applyRootBackground,
  createDivider,
  createDividerFlexFrameScheduler,
  getDividerHitSize
} from './pane-divider'
import {
  attachPaneDrag,
  createDragReorderState,
  handlePaneDrop,
  hideDropOverlay,
  showDropOverlay,
  updateMultiPaneState,
  type DragReorderCallbacks
} from './pane-drag-reorder'
import {
  applyPaneFlexStyle,
  detachPaneFromTree,
  findPaneChildren,
  fitAllPanesInternal,
  insertPaneNextTo,
  promoteSibling,
  refitPanesUnder,
  removeDividers,
  safeFit,
  wrapInSplit
} from './pane-tree-ops'

const paneManagerMocks = vi.hoisted(() => ({
  fitOverride: null as { cols: number; rows: number } | null,
  attachWebgl: vi.fn(),
  disposeWebgl: vi.fn()
}))

vi.mock('./mobile-fit-overrides', () => ({
  getFitOverrideForPty: vi.fn(() => paneManagerMocks.fitOverride)
}))

vi.mock('./pane-webgl-renderer', () => ({
  attachWebgl: paneManagerMocks.attachWebgl,
  disposeWebgl: paneManagerMocks.disposeWebgl
}))

type Listener = (event: FakeEvent) => void

class FakeClassList {
  private readonly names = new Set<string>()

  constructor(initial = '') {
    for (const name of initial.split(/\s+/)) {
      if (name) {
        this.names.add(name)
      }
    }
  }

  add(...names: string[]): void {
    for (const name of names) {
      this.names.add(name)
    }
  }

  remove(...names: string[]): void {
    for (const name of names) {
      this.names.delete(name)
    }
  }

  contains(name: string): boolean {
    return this.names.has(name)
  }

  toString(): string {
    return [...this.names].join(' ')
  }
}

class FakeStyle {
  [key: string]: string | ((name: string, value: string) => void) | undefined

  setProperty(name: string, value: string): void {
    this[name] = value
  }
}

type FakeRect = {
  left: number
  top: number
  width: number
  height: number
  right: number
  bottom: number
}

type FakeEvent = {
  type: string
  pointerId?: number
  clientX?: number
  clientY?: number
  preventDefault?: () => void
  stopPropagation?: () => void
}

class FakeElement {
  children: FakeElement[] = []
  parentElement: FakeElement | null = null
  dataset: Record<string, string> = {}
  style = new FakeStyle()
  listeners = new Map<string, Set<Listener>>()
  private rect: FakeRect = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100 }
  private classes = new FakeClassList()

  constructor(readonly tagName: string) {}

  get classList(): FakeClassList {
    return this.classes
  }

  set className(value: string) {
    this.classes = new FakeClassList(value)
  }

  get className(): string {
    return this.classes.toString()
  }

  get previousElementSibling(): FakeElement | null {
    if (!this.parentElement) {
      return null
    }
    const index = this.parentElement.children.indexOf(this)
    return index > 0 ? this.parentElement.children[index - 1]! : null
  }

  get nextElementSibling(): FakeElement | null {
    if (!this.parentElement) {
      return null
    }
    const index = this.parentElement.children.indexOf(this)
    return index >= 0 && index < this.parentElement.children.length - 1
      ? this.parentElement.children[index + 1]!
      : null
  }

  appendChild(child: FakeElement): FakeElement {
    child.remove()
    child.parentElement = this
    this.children.push(child)
    return child
  }

  replaceChild(newChild: FakeElement, oldChild: FakeElement): FakeElement {
    const index = this.children.indexOf(oldChild)
    if (index === -1) {
      throw new Error('old child not found')
    }
    newChild.remove()
    oldChild.parentElement = null
    newChild.parentElement = this
    this.children[index] = newChild
    return oldChild
  }

  remove(): void {
    if (!this.parentElement) {
      return
    }
    const siblings = this.parentElement.children
    const index = siblings.indexOf(this)
    if (index >= 0) {
      siblings.splice(index, 1)
    }
    this.parentElement = null
  }

  querySelectorAll(selector: string): FakeElement[] {
    const result: FakeElement[] = []
    const visit = (node: FakeElement): void => {
      for (const child of node.children) {
        if (
          (selector === '.pane-divider' && child.classList.contains('pane-divider')) ||
          (selector === '.pane[data-pane-id]' &&
            child.classList.contains('pane') &&
            child.dataset.paneId)
        ) {
          result.push(child)
        }
        visit(child)
      }
    }
    visit(this)
    return result
  }

  setRect(rect: Partial<FakeRect>): void {
    const width = rect.width ?? this.rect.width
    const height = rect.height ?? this.rect.height
    const left = rect.left ?? this.rect.left
    const top = rect.top ?? this.rect.top
    this.rect = {
      left,
      top,
      width,
      height,
      right: rect.right ?? left + width,
      bottom: rect.bottom ?? top + height
    }
  }

  getBoundingClientRect(): FakeRect {
    return this.rect
  }

  getAttributeNames(): string[] {
    return []
  }

  getAttribute(): string | null {
    return null
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(event: FakeEvent): boolean {
    for (const listener of this.listeners.get(event.type) ?? []) {
      listener(event)
    }
    return true
  }

  setPointerCapture(): void {}
  releasePointerCapture(): void {}
}

function fakeDocument(): { body: FakeElement; createElement: (tag: string) => FakeElement } {
  const body = new FakeElement('body')
  return {
    body,
    createElement: (tag: string) => new FakeElement(tag)
  }
}

function el(className?: string): FakeElement {
  const element = new FakeElement('div')
  if (className) {
    element.className = className
  }
  return element
}

function pane(id: number, rect?: Partial<FakeRect>): ManagedPaneInternal {
  const container = el('pane')
  container.dataset.paneId = String(id)
  if (rect) {
    container.setRect(rect)
  }
  return {
    id,
    container,
    terminal: {
      cols: 80,
      rows: 24,
      resize: vi.fn(),
      focus: vi.fn()
    },
    fitAddon: {
      fit: vi.fn(),
      proposeDimensions: vi.fn(() => ({ cols: 100, rows: 30 }))
    },
    webglAddon: null,
    gpuRenderingEnabled: true,
    webglDisabledAfterContextLoss: false
  } as unknown as ManagedPaneInternal
}

function pointer(type: string, x: number, y: number): FakeEvent {
  return {
    type,
    pointerId: 1,
    clientX: x,
    clientY: y,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn()
  }
}

describe('pane manager DOM operations', () => {
  beforeEach(() => {
    const document = fakeDocument()
    globalThis.document = {
      ...document,
      hasFocus: () => true
    } as never
    globalThis.window = { scrollX: 5, scrollY: 7 } as never
    globalThis.HTMLElement = FakeElement as never
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    }) as never
    globalThis.cancelAnimationFrame = vi.fn() as never
    paneManagerMocks.fitOverride = null
    paneManagerMocks.attachWebgl.mockClear()
    paneManagerMocks.disposeWebgl.mockClear()
  })

  it('styles dividers, panes, and the root using pane style options', () => {
    const root = el()
    const vertical = createDivider(true, { dividerThicknessPx: 6 }, { refitPanesUnder: vi.fn() })
    const horizontal = createDivider(false, {}, { refitPanesUnder: vi.fn() })
    root.appendChild(vertical)
    root.appendChild(horizontal)

    expect(getDividerHitSize({ dividerThicknessPx: 6 })).toBe(12)
    applyDividerStyles(root, { dividerThicknessPx: 6 })
    expect(vertical.style.width).toBe('12px')
    expect(horizontal.style.height).toBe('12px')
    expect(vertical.style['--divider-thickness']).toBe('6px')

    const active = pane(1)
    const inactive = pane(2)
    applyPaneOpacity([active, inactive], 1, {
      activePaneOpacity: 1,
      inactivePaneOpacity: 0.5,
      opacityTransitionMs: 120
    })
    expect(active.container.style.opacity).toBe('1')
    expect(inactive.container.style.opacity).toBe('0.5')
    expect(inactive.container.style.transition).toBe('opacity 120ms ease')

    applyRootBackground(root, { splitBackground: '#111', paddingX: 8, paddingY: 4 })
    expect(root.style.background).toBe('#111')
    expect(root.style['--pane-padding-x']).toBe('8px')
    expect(root.style['--pane-padding-y']).toBe('4px')
  })

  it('coalesces divider drag flex writes and persists real drags', () => {
    const applied: [number, number][] = []
    const scheduler = createDividerFlexFrameScheduler({
      apply: (prev, next) => applied.push([prev, next]),
      requestFrame: () => 77,
      cancelFrame: vi.fn()
    })
    scheduler.schedule(10, 90)
    scheduler.schedule(20, 80)
    scheduler.flush()
    expect(applied).toEqual([[20, 80]])

    const parent = el('pane-split')
    const prev = el('pane')
    const next = el('pane')
    prev.setRect({ width: 100, height: 100 })
    next.setRect({ left: 110, width: 100, height: 100 })
    const onLayoutChanged = vi.fn()
    const refitPanesUnderMock = vi.fn()
    const divider = createDivider(
      true,
      {},
      { refitPanesUnder: refitPanesUnderMock, onLayoutChanged }
    )
    parent.appendChild(prev)
    parent.appendChild(divider)
    parent.appendChild(next)

    divider.dispatchEvent(pointer('pointerdown', 100, 10))
    divider.dispatchEvent(pointer('pointermove', 140, 10))
    divider.dispatchEvent(pointer('pointerup', 140, 10))

    expect(prev.style.flex).toBe('140 1 0%')
    expect(next.style.flex).toBe('60 1 0%')
    expect(refitPanesUnderMock).toHaveBeenCalledWith(prev)
    expect(refitPanesUnderMock).toHaveBeenCalledWith(next)
    expect(onLayoutChanged).toHaveBeenCalledTimes(1)

    divider.dispatchEvent({ type: 'dblclick' })
    expect(prev.style.flex).toBe('1 1 0%')
    expect(next.style.flex).toBe('1 1 0%')
  })

  it('wraps, detaches, inserts, and promotes panes in the split tree', () => {
    const root = el()
    const existing = el('pane')
    const next = el('pane')
    const divider = el('pane-divider')
    root.appendChild(existing)

    wrapInSplit(existing, next, true, divider, { ratio: 0.25 })

    const split = root.children[0]!
    expect(split.classList.contains('pane-split')).toBe(true)
    expect(split.classList.contains('is-vertical')).toBe(true)
    expect(existing.style.flex).toBe('0.25 1 0%')
    expect(next.style.flex).toBe('0.75 1 0%')
    expect(findPaneChildren(split)).toEqual([existing, next])

    removeDividers(split)
    expect(split.children).toEqual([existing, next])

    const callbacks = {
      getRoot: () => root,
      getStyleOptions: () => ({}),
      safeFit: vi.fn(),
      refitPanesUnder: vi.fn(),
      onLayoutChanged: vi.fn()
    }
    detachPaneFromTree({ id: 1, container: existing } as ManagedPaneInternal, callbacks)
    expect(root.children[0]).toBe(next)

    const source = pane(3)
    const target = pane(4)
    root.children = []
    root.appendChild(target.container)
    source.webglAddon = {} as never
    target.webglAddon = {} as never
    insertPaneNextTo(source, target, 'left', callbacks)
    expect(root.children[0]!.classList.contains('pane-split')).toBe(true)
    expect(paneManagerMocks.disposeWebgl).toHaveBeenCalledWith(source)
    expect(paneManagerMocks.disposeWebgl).toHaveBeenCalledWith(target)
    expect(paneManagerMocks.attachWebgl).toHaveBeenCalledWith(source)
    expect(paneManagerMocks.attachWebgl).toHaveBeenCalledWith(target)

    const nestedRoot = el()
    const parent = el('pane-split')
    const sibling = el('pane')
    parent.style.flex = '2 1 0%'
    nestedRoot.appendChild(parent)
    parent.appendChild(sibling)
    promoteSibling(sibling, parent, nestedRoot)
    expect(nestedRoot.children[0]).toBe(sibling)
    expect(sibling.style.width).toBe('100%')
    applyPaneFlexStyle(sibling)
    expect(sibling.style.flex).toBe('1 1 0%')
  })

  it('handles pane drag reorder overlays and drop callbacks', () => {
    const root = el()
    const source = pane(1, { left: 0, top: 0, width: 100, height: 100 })
    const target = pane(2, { left: 120, top: 0, width: 100, height: 100 })
    root.appendChild(source.container)
    root.appendChild(target.container)
    const panes = new Map([
      [source.id, source],
      [target.id, target]
    ])
    const callbacks: DragReorderCallbacks = {
      getPanes: () => panes,
      getRoot: () => root,
      getStyleOptions: () => ({}),
      isDestroyed: () => false,
      safeFit: vi.fn(),
      applyPaneOpacity: vi.fn(),
      applyDividerStyles: vi.fn(),
      refitPanesUnder: vi.fn(),
      onLayoutChanged: vi.fn()
    }
    const state = createDragReorderState()

    updateMultiPaneState(callbacks)
    expect(root.classList.contains('has-multiple-panes')).toBe(true)
    showDropOverlay(state)
    expect(state.dropOverlay).toBeTruthy()
    hideDropOverlay(state)
    expect(state.dropOverlay).toBeNull()

    handlePaneDrop(1, 2, 'right', state, callbacks)
    expect(callbacks.safeFit).toHaveBeenCalledWith(source)
    expect(callbacks.safeFit).toHaveBeenCalledWith(target)
    expect(callbacks.applyPaneOpacity).toHaveBeenCalled()
    expect(callbacks.applyDividerStyles).toHaveBeenCalled()
    expect(callbacks.onLayoutChanged).toHaveBeenCalled()

    const handle = el()
    attachPaneDrag(handle, 1, state, callbacks)
    handle.dispatchEvent(pointer('pointerdown', 10, 10))
    handle.dispatchEvent(pointer('pointermove', 121, 50))
    expect(state.currentDropTarget).toEqual({ paneId: 2, zone: 'left' })
    expect(state.dropOverlay?.style.left).toBe('125px')
    handle.dispatchEvent(pointer('pointerup', 121, 50))
    expect(state.dragSourcePaneId).toBeNull()
    expect(state.currentDropTarget).toBeNull()
  })

  it('fits panes with mobile overrides, proposed dimensions, and nested refits', () => {
    const p1 = pane(1)
    p1.container.dataset.ptyId = 'pty-1'
    paneManagerMocks.fitOverride = { cols: 40, rows: 12 }
    safeFit(p1)
    expect(p1.terminal.resize).toHaveBeenCalledWith(40, 12)

    paneManagerMocks.fitOverride = null
    const p2 = pane(2)
    p2.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }))
    safeFit(p2)
    expect(p2.fitAddon.fit).not.toHaveBeenCalled()

    p2.fitAddon.proposeDimensions = vi.fn(() => ({ cols: 100, rows: 30 }))
    safeFit(p2)
    expect(p2.fitAddon.fit).toHaveBeenCalled()

    const panes = new Map([
      [p1.id, p1],
      [p2.id, p2]
    ])
    fitAllPanesInternal(panes)

    const root = el('pane-split')
    root.appendChild(p1.container)
    root.appendChild(p2.container)
    refitPanesUnder(root, panes)
    expect(p2.fitAddon.fit).toHaveBeenCalledTimes(3)

    expect(() =>
      safeFit({
        ...p2,
        fitAddon: {
          proposeDimensions: vi.fn(() => {
            throw new Error('not ready')
          }),
          fit: vi.fn()
        }
      } as unknown as ManagedPaneInternal)
    ).not.toThrow()
  })
})
