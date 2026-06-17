import type { DropZone, ManagedPaneInternal } from './pane-manager-types'
import type { PaneDropAsNewTabPlacement } from './pane-manager-types'
import type { DragReorderCallbacks, DragReorderState } from './pane-drag-reorder'

const TAB_DROP_BEFORE_CLASS = 'pane-tab-drop-before'
const TAB_DROP_AFTER_CLASS = 'pane-tab-drop-after'

/** Determine which pane/new-tab target the cursor is over, and position the overlay. */
export function updatePaneDragDropTarget(
  clientX: number,
  clientY: number,
  state: DragReorderState,
  callbacks: DragReorderCallbacks
): void {
  const overlay = state.dropOverlay
  if (!overlay) {
    return
  }
  clearTabDropIndicators()

  const targetPane = findTargetPane(clientX, clientY, state, callbacks)
  if (!targetPane) {
    updateNewTabDropTarget(clientX, clientY, state, callbacks, overlay)
    return
  }

  const rect = targetPane.container.getBoundingClientRect()
  const zone = resolvePaneDropZone(clientX, clientY, rect)

  state.currentDropTarget = { type: 'pane', paneId: targetPane.id, zone }
  positionPaneDropOverlay(overlay, rect, zone)
}

function findTargetPane(
  clientX: number,
  clientY: number,
  state: DragReorderState,
  callbacks: DragReorderCallbacks
): ManagedPaneInternal | null {
  for (const pane of callbacks.getPanes().values()) {
    if (pane.id === state.dragSourcePaneId) {
      continue
    }
    const rect = pane.container.getBoundingClientRect()
    if (
      clientX >= rect.left &&
      clientX <= rect.right &&
      clientY >= rect.top &&
      clientY <= rect.bottom
    ) {
      return pane
    }
  }
  return null
}

function updateNewTabDropTarget(
  clientX: number,
  clientY: number,
  state: DragReorderState,
  callbacks: DragReorderCallbacks,
  overlay: HTMLElement
): void {
  const tabBarTarget = findTabBarDropTarget(clientX, clientY)
  if (tabBarTarget && callbacks.onPaneDropAsNewTab) {
    const placement = resolveTabBarPlacement(tabBarTarget, clientX)
    if (!placement) {
      overlay.style.display = 'none'
      state.currentDropTarget = null
      return
    }
    state.currentDropTarget = { type: 'new-tab', placement }
    updateTabDropIndicators(tabBarTarget, placement)
    overlay.style.display = 'none'
    return
  }

  const rootRect = callbacks.getRoot().getBoundingClientRect()
  const isInsideRoot =
    clientX >= rootRect.left &&
    clientX <= rootRect.right &&
    clientY >= rootRect.top &&
    clientY <= rootRect.bottom
  if (!isInsideRoot || !callbacks.onPaneDropAsNewTab) {
    overlay.style.display = 'none'
    state.currentDropTarget = null
    return
  }

  state.currentDropTarget = { type: 'new-tab' }
  positionNewTabDropOverlay(overlay, rootRect, 'surface')
}

export function clearPaneTabDropTargetIndicators(): void {
  clearTabDropIndicators()
}

function findTabBarDropTarget(clientX: number, clientY: number): HTMLElement | null {
  const element = document.elementFromPoint?.(clientX, clientY)
  if (!element || typeof element.closest !== 'function') {
    return null
  }
  const target = element.closest<HTMLElement>('[data-pane-drop-new-tab-target="true"]')
  if (target) {
    return target
  }
  return (
    element
      .closest<HTMLElement>('.terminal-tab-strip')
      ?.closest<HTMLElement>('[data-pane-drop-new-tab-target="true"]') ?? null
  )
}

function resolveTabBarPlacement(
  tabBarTarget: HTMLElement,
  clientX: number
): PaneDropAsNewTabPlacement | null {
  const groupId = tabBarTarget.dataset.paneDropNewTabGroupId
  if (!groupId) {
    return null
  }
  const tabs = getTabBarTabs(tabBarTarget)
  if (tabs.length === 0) {
    return { groupId }
  }
  const hoveredTab = tabs.find((tab) => {
    const rect = tab.getBoundingClientRect()
    return clientX >= rect.left && clientX <= rect.right
  })
  const targetTab =
    hoveredTab ?? (clientX < tabs[0]!.getBoundingClientRect().left ? tabs[0] : tabs.at(-1))
  if (!targetTab) {
    return { groupId }
  }
  const rect = targetTab.getBoundingClientRect()
  const side = !hoveredTab
    ? clientX < rect.left
      ? 'left'
      : 'right'
    : clientX < rect.left + rect.width / 2
      ? 'left'
      : 'right'
  const targetUnifiedTabId = targetTab.dataset.unifiedTabId
  return targetUnifiedTabId ? { groupId, targetUnifiedTabId, side } : { groupId }
}

function updateTabDropIndicators(
  tabBarTarget: HTMLElement,
  placement: PaneDropAsNewTabPlacement
): void {
  if (!placement.targetUnifiedTabId || !placement.side) {
    return
  }
  const tabs = getTabBarTabs(tabBarTarget)
  const targetIndex = tabs.findIndex(
    (tab) => tab.dataset.unifiedTabId === placement.targetUnifiedTabId
  )
  if (targetIndex === -1) {
    return
  }
  const insertionIndex = targetIndex + (placement.side === 'right' ? 1 : 0)
  tabs[insertionIndex - 1]?.classList.add(TAB_DROP_AFTER_CLASS)
  tabs[insertionIndex]?.classList.add(TAB_DROP_BEFORE_CLASS)
}

function getTabBarTabs(tabBarTarget: HTMLElement): HTMLElement[] {
  return Array.from(tabBarTarget.querySelectorAll<HTMLElement>('[data-unified-tab-id]')).filter(
    (tab) => {
      const rect = tab.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
  )
}

function clearTabDropIndicators(): void {
  document
    .querySelectorAll<HTMLElement>(`.${TAB_DROP_BEFORE_CLASS}, .${TAB_DROP_AFTER_CLASS}`)
    .forEach((element) => {
      element.classList.remove(TAB_DROP_BEFORE_CLASS, TAB_DROP_AFTER_CLASS)
    })
}

function positionNewTabDropOverlay(
  overlay: HTMLElement,
  rect: DOMRect,
  mode: 'surface' | 'target'
): void {
  overlay.style.display = ''
  overlay.style.left = `${rect.left + window.scrollX}px`
  overlay.style.top = `${rect.top + window.scrollY}px`
  overlay.style.width = `${rect.width}px`
  overlay.style.height = mode === 'surface' ? '28px' : `${Math.min(rect.height || 28, 32)}px`
}

function resolvePaneDropZone(clientX: number, clientY: number, rect: DOMRect): DropZone {
  const relX = (clientX - rect.left) / rect.width
  const relY = (clientY - rect.top) / rect.height
  const distTop = relY
  const distBottom = 1 - relY
  const distLeft = relX
  const distRight = 1 - relX
  const minDist = Math.min(distTop, distBottom, distLeft, distRight)

  if (minDist === distTop) {
    return 'top'
  }
  if (minDist === distBottom) {
    return 'bottom'
  }
  if (minDist === distLeft) {
    return 'left'
  }
  return 'right'
}

function positionPaneDropOverlay(overlay: HTMLElement, rect: DOMRect, zone: DropZone): void {
  overlay.style.display = ''
  const scrollX = window.scrollX
  const scrollY = window.scrollY

  switch (zone) {
    case 'top':
      overlay.style.left = `${rect.left + scrollX}px`
      overlay.style.top = `${rect.top + scrollY}px`
      overlay.style.width = `${rect.width}px`
      overlay.style.height = `${rect.height / 2}px`
      break
    case 'bottom':
      overlay.style.left = `${rect.left + scrollX}px`
      overlay.style.top = `${rect.top + scrollY + rect.height / 2}px`
      overlay.style.width = `${rect.width}px`
      overlay.style.height = `${rect.height / 2}px`
      break
    case 'left':
      overlay.style.left = `${rect.left + scrollX}px`
      overlay.style.top = `${rect.top + scrollY}px`
      overlay.style.width = `${rect.width / 2}px`
      overlay.style.height = `${rect.height}px`
      break
    case 'right':
      overlay.style.left = `${rect.left + scrollX + rect.width / 2}px`
      overlay.style.top = `${rect.top + scrollY}px`
      overlay.style.width = `${rect.width / 2}px`
      overlay.style.height = `${rect.height}px`
      break
  }
}
