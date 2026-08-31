/* eslint-disable unicorn/no-useless-spread */
// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal } from './orca-runtime-create-runtime-owned-mobile-session-terminal'
import type { RuntimeMobileSessionCreateTerminalResult } from '../../shared/runtime-types'
import { MOBILE_TERMINAL_SURFACE_TIMEOUT_MS } from './orca-runtime-core'
import { parsePaneKey } from '../../shared/stable-pane-id'

export class OrcaRuntimeWithWaitForMobileTerminalSurface extends OrcaRuntimeWithCreateRuntimeOwnedMobileSessionTerminal {
  protected waitForMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options: { timeoutMs?: number; requireReady?: boolean; signal?: AbortSignal } = {}
  ): Promise<RuntimeMobileSessionCreateTerminalResult> {
    const timeoutMs = options.timeoutMs ?? MOBILE_TERMINAL_SURFACE_TIMEOUT_MS
    const existing = this.findMobileTerminalSurface(worktreeId, parentTabId, options)
    if (existing) {
      return Promise.resolve(existing)
    }
    if (options.signal?.aborted) {
      return Promise.reject(new Error('client_disconnected'))
    }

    return new Promise<RuntimeMobileSessionCreateTerminalResult>((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        const idx = this.graphSyncCallbacks.indexOf(check)
        if (idx !== -1) {
          this.graphSyncCallbacks.splice(idx, 1)
        }
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('Timed out waiting for terminal surface after creation'))
      }, timeoutMs)
      // Why: a dead client connection cancels the wait immediately instead of running down the timeout into rollback (#7718).
      const onAbort = (): void => {
        cleanup()
        reject(new Error('client_disconnected'))
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const check = (): void => {
        const next = this.findMobileTerminalSurface(worktreeId, parentTabId, options)
        if (!next) {
          return
        }
        cleanup()
        resolve(next)
      }
      this.graphSyncCallbacks.push(check)
      check()
    })
  }

  protected findMobileTerminalSurface(
    worktreeId: string,
    parentTabId: string,
    options: { requireReady?: boolean } = {}
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return null
    }
    const result = this.toMobileSessionTabsResult(snapshot)
    const tab = result.tabs.find(
      (candidate) => candidate.type === 'terminal' && candidate.parentTabId === parentTabId
    )
    if (!tab || tab.type !== 'terminal') {
      return null
    }
    const surface = {
      tab,
      publicationEpoch: result.publicationEpoch,
      snapshotVersion: result.snapshotVersion
    }
    if (options.requireReady === true && !this.isReadyMobileTerminalSurface(surface)) {
      return null
    }
    return surface
  }

  protected findMobileTerminalSurfaceForPty(
    worktreeId: string,
    ptyId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    const tab = snapshot?.tabs.find(
      (candidate) =>
        candidate.type === 'terminal' &&
        (candidate.ptyId === ptyId ||
          candidate.parentLayout?.ptyIdsByLeafId?.[candidate.leafId] === ptyId)
    )
    return tab?.type === 'terminal'
      ? this.findMobileTerminalSurface(worktreeId, tab.parentTabId)
      : null
  }

  // Why: publish an in-flight mobile create main-side from the live PTY so it can't stall on graph sync and destroy the session (#7587).
  protected ensurePtyBackedMobileSurfaceForRendererTab(
    worktreeId: string,
    tabId: string
  ): RuntimeMobileSessionCreateTerminalResult | null {
    const pending = this.pendingMobileTerminalCreatesByKey.get(`${worktreeId}::${tabId}`)
    if (!pending) {
      return null
    }
    const existing = this.findMobileTerminalSurface(worktreeId, tabId)
    const pty = this.findLiveRegisteredPtyForRendererTab(worktreeId, tabId)
    if (pty) {
      pty.runtimeSessionOwned = true
      if (pending.paired) {
        this.setPairedRendererSessionOwnership(pty.ptyId, true)
      }
    }
    if (
      existing &&
      this.isReadyMobileTerminalSurface(existing) &&
      (pending.viewMode === undefined || existing.tab.viewMode === pending.viewMode)
    ) {
      // Why: the renderer's ready publication already landed with the intended mode; only a pending shell needs the main-side rescue.
      return existing
    }
    const leafId = pty ? parsePaneKey(pty.paneKey ?? '')?.leafId : undefined
    if (!pty || !leafId) {
      return existing
    }
    this.publishPtyBackedMobileSessionTerminal(worktreeId, pty, {
      tabId,
      leafId,
      title: null,
      activate: pending.activate,
      selectIfNoActiveTab: pending.selectIfNoActiveTab,
      ...(pending.viewMode ? { viewMode: pending.viewMode } : {})
    })
    // Why: check closures normally drain only inside syncWindowGraph; a main-side publish must drain them too or the pending wait misses the insertion.
    for (const cb of [...this.graphSyncCallbacks]) {
      cb()
    }
    return this.findMobileTerminalSurface(worktreeId, tabId)
  }
}
