// @ts-nocheck -- Fake DOM elements model only the layout fields this unit exercises.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyExpandedLayoutTo,
  createExpandCollapseActions,
  restoreExpandedLayoutFrom
} from './expand-collapse'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'

vi.mock('@/lib/pane-manager/pane-tree-ops', () => ({
  safeFit: vi.fn()
}))

class FakeHTMLElement {
  children: FakeHTMLElement[] = []
  parentElement: FakeHTMLElement | null = null
  style = { display: '', flex: '' }

  append(child: FakeHTMLElement): void {
    child.parentElement = this
    this.children.push(child)
  }
}

function makeTree() {
  const root = new FakeHTMLElement()
  const split = new FakeHTMLElement()
  const target = new FakeHTMLElement()
  const sibling = new FakeHTMLElement()
  split.style.display = 'flex'
  split.style.flex = '0 0 50%'
  target.style.flex = '0 0 40%'
  sibling.style.flex = '0 0 60%'
  root.append(split)
  split.append(target)
  split.append(sibling)
  const panes = [
    { id: 1, container: target, terminal: { focus: vi.fn() } },
    { id: 2, container: sibling, terminal: { focus: vi.fn() } }
  ]
  const manager = {
    getActivePane: vi.fn(() => panes[0]),
    getPanes: vi.fn(() => panes),
    setActivePane: vi.fn()
  }
  return { manager, panes, root, sibling, split, target }
}

function makeState(overrides: Record<string, unknown> = {}) {
  const { manager, panes, root, sibling, split, target } = makeTree()
  const state = {
    containerRef: { current: root },
    expandedPaneIdRef: { current: null as number | null },
    expandedStyleSnapshotRef: { current: new Map() },
    managerRef: { current: manager },
    persistLayoutSnapshot: vi.fn(),
    setExpandedPaneId: vi.fn(),
    setTabPaneExpanded: vi.fn(),
    tabId: 'tab-1',
    ...overrides
  }
  return { manager, panes, root, sibling, split, state, target }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('HTMLElement', FakeHTMLElement)
  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((callback: FrameRequestCallback) => {
      callback(0)
      return 1
    })
  )
})

describe('expand-collapse layout helpers', () => {
  it('applies and restores expanded layout styles', () => {
    const { sibling, split, state, target } = makeState()

    expect(applyExpandedLayoutTo(1, state)).toBe(true)

    expect(target.style.flex).toBe('1 1 auto')
    expect(sibling.style.display).toBe('none')
    expect(split.style.flex).toBe('1 1 auto')
    expect(state.expandedStyleSnapshotRef.current.size).toBeGreaterThan(0)

    restoreExpandedLayoutFrom(state.expandedStyleSnapshotRef.current)

    expect(target.style.flex).toBe('0 0 40%')
    expect(sibling.style.display).toBe('')
    expect(split.style.flex).toBe('0 0 50%')
    expect(state.expandedStyleSnapshotRef.current.size).toBe(0)
  })

  it('returns false when the manager, root, target, or split count is missing', () => {
    const { state } = makeState()

    expect(applyExpandedLayoutTo(1, { ...state, managerRef: { current: null } })).toBe(false)
    expect(applyExpandedLayoutTo(1, { ...state, containerRef: { current: null } })).toBe(false)
    expect(applyExpandedLayoutTo(999, state)).toBe(false)
    state.managerRef.current.getPanes.mockReturnValueOnce([state.managerRef.current.getPanes()[0]])
    expect(applyExpandedLayoutTo(1, state)).toBe(false)
  })

  it('toggles, syncs, refreshes, and collapses expanded panes', () => {
    const { manager, panes, state } = makeState()
    const actions = createExpandCollapseActions(state)

    actions.setExpandedPane(1)
    expect(state.expandedPaneIdRef.current).toBe(1)
    expect(state.setExpandedPaneId).toHaveBeenCalledWith(1)
    expect(state.setTabPaneExpanded).toHaveBeenCalledWith('tab-1', true)

    actions.refreshPaneSizes(true)
    expect(safeFit).toHaveBeenCalledTimes(2)
    expect(panes[0].terminal.focus).toHaveBeenCalled()

    state.expandedPaneIdRef.current = null
    actions.toggleExpandPane(1)
    expect(manager.setActivePane).toHaveBeenCalledWith(1, { focus: true })

    actions.toggleExpandPane(1)
    expect(state.expandedPaneIdRef.current).toBeNull()
    expect(state.setTabPaneExpanded).toHaveBeenLastCalledWith('tab-1', false)

    state.expandedPaneIdRef.current = 1
    manager.getPanes.mockReturnValueOnce([panes[1]])
    actions.syncExpandedLayout()
    expect(state.expandedPaneIdRef.current).toBeNull()

    state.expandedPaneIdRef.current = null
    actions.syncExpandedLayout()
    expect(state.expandedStyleSnapshotRef.current.size).toBe(0)
  })

  it('no-ops toggles without a manager or multiple panes', () => {
    const { state } = makeState({ managerRef: { current: null } })
    const actions = createExpandCollapseActions(state)

    actions.toggleExpandPane(1)
    expect(state.setExpandedPaneId).not.toHaveBeenCalled()

    const single = makeState()
    single.manager.getPanes.mockReturnValue([single.panes[0]])
    createExpandCollapseActions(single.state).toggleExpandPane(1)
    expect(single.state.setExpandedPaneId).not.toHaveBeenCalled()
  })
})
