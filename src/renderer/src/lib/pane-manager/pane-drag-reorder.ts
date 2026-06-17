import type {
  DropZone,
  ManagedPane,
  ManagedPaneInternal,
  PaneDropAsNewTabPlacement
} from './pane-manager-types'
import type { PaneStyleOptions } from './pane-manager-types'
import { clearPaneTabDropTargetIndicators, updatePaneDragDropTarget } from './pane-drag-drop-target'
import { detachPaneFromTree, insertPaneNextTo } from './pane-tree-ops'

// ---------------------------------------------------------------------------
// Drag-to-reorder panes
// ---------------------------------------------------------------------------

export type DragReorderState = {
  dragSourcePaneId: number | null
  dropOverlay: HTMLElement | null
  currentDropTarget:
    | { type: 'pane'; paneId: number; zone: DropZone }
    | { type: 'new-tab'; placement?: PaneDropAsNewTabPlacement }
    | null
  cleanupActiveDrag: ((commitDrop: boolean) => void) | null
}

export type DragReorderCallbacks = {
  getPanes: () => Map<number, ManagedPaneInternal>
  getRoot: () => HTMLElement
  getStyleOptions: () => PaneStyleOptions
  isDestroyed: () => boolean
  safeFit: (pane: ManagedPane) => void
  applyPaneOpacity: () => void
  applyDividerStyles: () => void
  refitPanesUnder: (el: HTMLElement) => void
  requestPaneReparentFrame?: (callback: FrameRequestCallback) => void
  onLayoutChanged?: () => void
  onDragActiveChange?: (active: boolean) => void
  onPaneDropAsNewTab?: (pane: ManagedPane, placement?: PaneDropAsNewTabPlacement) => boolean
}

export function createDragReorderState(): DragReorderState {
  return {
    dragSourcePaneId: null,
    dropOverlay: null,
    currentDropTarget: null,
    cleanupActiveDrag: null
  }
}

/** Attach drag-to-reorder handlers to a pane's drag handle. */
export function attachPaneDrag(
  handle: HTMLElement,
  paneId: number,
  state: DragReorderState,
  callbacks: DragReorderCallbacks
): () => void {
  let dragging = false
  let startX = 0
  let startY = 0
  let activePointerId: number | null = null
  let cleanupCurrentDrag: ((commitDrop: boolean) => void) | null = null
  const DRAG_THRESHOLD = 5

  const onPointerDown = (e: PointerEvent): void => {
    // Only start drag if there are 2+ panes
    if (callbacks.getPanes().size < 2) {
      return
    }
    e.preventDefault()
    e.stopPropagation()
    handle.setPointerCapture(e.pointerId)
    activePointerId = e.pointerId
    startX = e.clientX
    startY = e.clientY
    dragging = false

    const cleanupDrag = (commitDrop: boolean): void => {
      const pointerId = activePointerId
      handle.removeEventListener('pointermove', onPointerMoveOuter)
      handle.removeEventListener('pointerup', onPointerUpOuter)
      handle.removeEventListener('pointercancel', onPointerCancelOuter)
      handle.removeEventListener('lostpointercapture', onLostPointerCaptureOuter)
      window.removeEventListener('blur', onWindowBlur, true)
      activePointerId = null
      if (state.cleanupActiveDrag === cleanupDrag) {
        state.cleanupActiveDrag = null
      }
      if (cleanupCurrentDrag === cleanupDrag) {
        cleanupCurrentDrag = null
      }
      if (pointerId !== null && handle.hasPointerCapture(pointerId)) {
        handle.releasePointerCapture(pointerId)
      }

      if (!dragging) {
        return
      }

      dragging = false
      callbacks.getRoot().classList.remove('is-pane-dragging')
      const sourcePane = callbacks.getPanes().get(paneId)
      if (sourcePane) {
        sourcePane.container.classList.remove('is-drag-source')
      }

      try {
        if (commitDrop && state.currentDropTarget && state.dragSourcePaneId !== null) {
          if (state.currentDropTarget.type === 'new-tab') {
            const sourcePane = callbacks.getPanes().get(state.dragSourcePaneId)
            if (sourcePane) {
              callbacks.onPaneDropAsNewTab?.(sourcePane, state.currentDropTarget.placement)
            }
            return
          }
          handlePaneDrop(
            state.dragSourcePaneId,
            state.currentDropTarget.paneId,
            state.currentDropTarget.zone,
            state,
            callbacks
          )
        }
      } finally {
        // Why: pointer capture can be lost when a terminal-pane drag crosses
        // an Electron webview. Always clear the visual/input drag state so the
        // terminal does not stay frozen behind the blue drop overlay.
        callbacks.onDragActiveChange?.(false)
        hideDropOverlay(state)
        state.dragSourcePaneId = null
        state.currentDropTarget = null
      }
    }

    const onPointerMoveOuter = (ev: PointerEvent): void => {
      if (ev.pointerId !== activePointerId || callbacks.isDestroyed()) {
        if (callbacks.isDestroyed()) {
          cleanupDrag(false)
        }
        return
      }
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!dragging && Math.hypot(dx, dy) >= DRAG_THRESHOLD) {
        dragging = true
        state.dragSourcePaneId = paneId
        callbacks.getRoot().classList.add('is-pane-dragging')
        callbacks.onDragActiveChange?.(true)
        const sourcePane = callbacks.getPanes().get(paneId)
        if (sourcePane) {
          sourcePane.container.classList.add('is-drag-source')
        }
        showDropOverlay(state)
      }
      if (dragging) {
        updatePaneDragDropTarget(ev.clientX, ev.clientY, state, callbacks)
      }
    }

    const onPointerUpOuter = (ev: PointerEvent): void => {
      if (ev.pointerId !== activePointerId) {
        return
      }
      cleanupDrag(true)
    }

    const onPointerCancelOuter = (ev: PointerEvent): void => {
      if (ev.pointerId !== activePointerId) {
        return
      }
      cleanupDrag(false)
    }

    const onLostPointerCaptureOuter = (ev: PointerEvent): void => {
      if (ev.pointerId !== activePointerId) {
        return
      }
      cleanupDrag(false)
    }

    const onWindowBlur = (): void => {
      cleanupDrag(false)
    }

    cleanupCurrentDrag = cleanupDrag
    state.cleanupActiveDrag = cleanupDrag
    handle.addEventListener('pointermove', onPointerMoveOuter)
    handle.addEventListener('pointerup', onPointerUpOuter)
    handle.addEventListener('pointercancel', onPointerCancelOuter)
    handle.addEventListener('lostpointercapture', onLostPointerCaptureOuter)
    window.addEventListener('blur', onWindowBlur, true)
  }

  handle.addEventListener('pointerdown', onPointerDown)
  return () => {
    cleanupCurrentDrag?.(false)
    handle.removeEventListener('pointerdown', onPointerDown)
  }
}

export function cancelActivePaneDrag(state: DragReorderState): void {
  if (state.cleanupActiveDrag) {
    state.cleanupActiveDrag(false)
    return
  }
  hideDropOverlay(state)
  state.dragSourcePaneId = null
  state.currentDropTarget = null
}

/** Move a pane from its current position to a new position relative to a target pane. */
export function handlePaneDrop(
  sourcePaneId: number,
  targetPaneId: number,
  zone: DropZone,
  _state: DragReorderState,
  callbacks: DragReorderCallbacks
): void {
  if (sourcePaneId === targetPaneId) {
    return
  }
  const panes = callbacks.getPanes()
  const source = panes.get(sourcePaneId)
  const target = panes.get(targetPaneId)
  if (!source || !target) {
    return
  }

  // 1. Detach source pane from the tree (without disposing its terminal)
  detachPaneFromTree(source, callbacks)

  // 2. Insert source next to target in the requested zone
  insertPaneNextTo(source, target, zone, callbacks)

  // 3. Refit all panes and persist
  for (const p of panes.values()) {
    callbacks.safeFit(p)
  }
  callbacks.applyPaneOpacity()
  callbacks.applyDividerStyles()
  updateMultiPaneState(callbacks)
  callbacks.onLayoutChanged?.()
}

export function showDropOverlay(state: DragReorderState): void {
  if (!state.dropOverlay) {
    const overlay = document.createElement('div')
    overlay.className = 'pane-drop-overlay'
    document.body.appendChild(overlay)
    state.dropOverlay = overlay
  }
  state.dropOverlay.style.display = 'none'
}

export function hideDropOverlay(state: DragReorderState): void {
  clearPaneTabDropTargetIndicators()
  if (state.dropOverlay) {
    state.dropOverlay.remove()
    state.dropOverlay = null
  }
}

/** Add/remove .has-multiple-panes on root to control drag handle visibility. */
export function updateMultiPaneState(callbacks: DragReorderCallbacks): void {
  if (callbacks.getPanes().size >= 2) {
    callbacks.getRoot().classList.add('has-multiple-panes')
  } else {
    callbacks.getRoot().classList.remove('has-multiple-panes')
  }
}
