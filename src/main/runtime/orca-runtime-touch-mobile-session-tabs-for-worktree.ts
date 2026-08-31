// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal } from './orca-runtime-publish-pty-backed-mobile-session-terminal'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { hasHostAuthoritativeTerminalMembership } from './workspace-session-terminal-membership-authority'
import type {
  RuntimeMobileSessionTabsSnapshot,
  RuntimeSyncedLeaf
} from '../../shared/runtime-types'
import { retireTerminalSurfacesFromSnapshot } from './mobile-session-terminal-retirement'

export class OrcaRuntimeWithTouchMobileSessionTabsForWorktree extends OrcaRuntimeWithPublishPtyBackedMobileSessionTerminal {
  /** Bump the snapshot version and emit, coalesced unless `immediate`.
   *  Why the bump: clients gate mirrored snapshots on a strictly increasing
   *  `snapshotVersion`, so a re-emit at the same version is silently dropped. */
  touchMobileSessionTabsForWorktree(
    worktreeId: string,
    options: { immediate?: boolean } = {}
  ): void {
    const snapshot = this.mobileSessionTabsByWorktree.get(worktreeId)
    if (!snapshot) {
      return
    }
    this.mobileSessionTabsByWorktree.set(worktreeId, {
      ...snapshot,
      snapshotVersion: snapshot.snapshotVersion + 1
    })
    if (options.immediate) {
      // Why: readiness/lifecycle changes are structural and must not wait
      // behind the title/status coalescing window.
      this.notifyMobileSessionTabsChanged(worktreeId)
      return
    }
    // Why: title/status flips several times a second under spinner-in-title
    // agents. Coalesce the emit instead of fanning out every version.
    this.scheduleMobileSessionTabsChanged(worktreeId)
  }

  /** Republish the workspace snapshot after a pane's hook status changed.
   *  Hook rows feed the headless `agentStatus` projection, which nothing else touches. */
  touchMobileSessionTabsForPane(paneKey: string, worktreeId?: string | null): void {
    const resolved = worktreeId ?? this.getTerminalWorktreeIdForPaneKey(paneKey)
    if (!resolved) {
      return
    }
    this.touchMobileSessionTabsForWorktree(resolved)
  }

  protected mobileSessionSnapshotHasSurface(
    worktreeId: string,
    parentTabId: string,
    leafId: string
  ): boolean {
    return Boolean(
      this.mobileSessionTabsByWorktree
        .get(worktreeId)
        ?.tabs.some(
          (tab) =>
            tab.type === 'terminal' && tab.parentTabId === parentTabId && tab.leafId === leafId
        )
    )
  }

  protected isMobileSessionSurfaceMembershipAllowed(
    worktreeId: string,
    parentTabId: string,
    leafId: string,
    candidatePtyId: string | null | undefined
  ): boolean {
    const session = this.getWorkspaceSessionForWorktree(worktreeId)
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    const pty = candidatePtyId ? this.ptysById.get(candidatePtyId) : undefined
    const pane = parsePaneKey(pty?.paneKey ?? '')
    const hasExactLiveBinding = Boolean(
      pty?.connected &&
      pty.worktreeId === worktreeId &&
      pty.tabId === parentTabId &&
      pane?.leafId === leafId
    )
    if (candidatePtyId && this.retiredMobileSessionPtyIds.has(candidatePtyId)) {
      return false
    }
    if (session && this.pendingMobileTerminalCreatesByKey.has(`${worktreeId}::${parentTabId}`)) {
      return true
    }
    if (session) {
      const persistedTabs = session.tabsByWorktree?.[worktreeId] ?? []
      const persistedParent = persistedTabs.find((tab) => tab.id === parentTabId)
      const persistedPtyIds = new Set(
        persistedParent
          ? [
              persistedParent.ptyId,
              ...Object.values(session.terminalLayoutsByTabId?.[parentTabId]?.ptyIdsByLeafId ?? {})
            ].filter((ptyId): ptyId is string => typeof ptyId === 'string')
          : []
      )
      if (
        persistedParent &&
        candidatePtyId &&
        !persistedPtyIds.has(candidatePtyId) &&
        !hasExactLiveBinding
      ) {
        return false
      }
    }
    if (
      !hasHostAuthoritativeTerminalMembership(session ?? undefined, worktreeId) &&
      (session !== undefined || !this.terminalTopologyRevisionByRepoId.has(repoId))
    ) {
      return true
    }
    if (this.mobileSessionSnapshotHasSurface(worktreeId, parentTabId, leafId)) {
      return true
    }
    if (!candidatePtyId) {
      return false
    }
    return hasExactLiveBinding
  }

  protected reconcileMobileSessionRetirementFences(
    leaves: readonly RuntimeSyncedLeaf[]
  ): RuntimeSyncedLeaf[] {
    return leaves.filter((leaf) =>
      this.isMobileSessionSurfaceMembershipAllowed(
        leaf.worktreeId,
        leaf.tabId,
        leaf.leafId,
        leaf.ptyId
      )
    )
  }

  protected applyMobileSessionRetirementFences(
    snapshot: RuntimeMobileSessionTabsSnapshot
  ): RuntimeMobileSessionTabsSnapshot {
    let next = snapshot
    for (const tab of snapshot.tabs) {
      if (
        tab.type !== 'terminal' ||
        this.isMobileSessionSurfaceMembershipAllowed(
          snapshot.worktree,
          tab.parentTabId,
          tab.leafId,
          tab.ptyId
        )
      ) {
        continue
      }
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot: next,
        ptyId: tab.ptyId ?? '',
        exactSurfaces: [{ parentTabId: tab.parentTabId, leafId: tab.leafId }],
        exactOnly: true
      })
      if (retired) {
        next = retired.snapshot
      }
    }
    return next
  }
}
