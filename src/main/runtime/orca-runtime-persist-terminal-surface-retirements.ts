// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithTouchMobileSessionTabsForWorktree } from './orca-runtime-touch-mobile-session-tabs-for-worktree'
import type { RetiredTerminalSurface } from './mobile-session-terminal-retirement'
import type { ExecutionHostId } from '../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'
import { retireTerminalSurfacesFromSnapshot } from './mobile-session-terminal-retirement'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'

export class OrcaRuntimeWithPersistTerminalSurfaceRetirements extends OrcaRuntimeWithTouchMobileSessionTabsForWorktree {
  /**
   * Retires each surface in the session partition of the host that owns its worktree.
   * Why: an SSH pane's durable surface lives in that connection's partition; retiring it
   * against the local partition strands the real ghost and bumps a foreign host's epoch.
   * Returns null when nothing may be published because persistence is unavailable or failed.
   */
  protected persistTerminalSurfaceRetirements(
    retiredSurfaces: readonly RetiredTerminalSurface[]
  ): { accepted: RetiredTerminalSurface[]; unpersisted: RetiredTerminalSurface[] } | null {
    const surfacesByHostId = new Map<ExecutionHostId, RetiredTerminalSurface[]>()
    for (const surface of retiredSurfaces) {
      const hostId =
        this.tryGetWorkspaceSessionHostIdForWorktree(surface.worktreeId) ?? LOCAL_EXECUTION_HOST_ID
      const bucket = surfacesByHostId.get(hostId)
      if (bucket) {
        bucket.push(surface)
      } else {
        surfacesByHostId.set(hostId, [surface])
      }
    }
    const accepted: RetiredTerminalSurface[] = []
    const unpersisted: RetiredTerminalSurface[] = []
    const pendingWrites: { hostId: ExecutionHostId; session: WorkspaceSessionState }[] = []
    for (const [hostId, surfaces] of surfacesByHostId) {
      const session = this.store?.getWorkspaceSession?.(hostId)
      if (!session) {
        unpersisted.push(...surfaces)
        continue
      }
      // Why: publishing absence before its host membership fence is durable lets a crash or
      // stale renderer write resurrect the retired surface.
      if (!this.store?.setWorkspaceSession || !this.store.flushOrThrow) {
        return null
      }
      let nextSession = session
      const acceptedForHost: RetiredTerminalSurface[] = []
      for (const surface of surfaces) {
        const candidate = retireTerminalSurfaceFromPersistence(nextSession, surface)
        if (candidate !== nextSession) {
          acceptedForHost.push(surface)
          nextSession = candidate
        }
      }
      if (acceptedForHost.length === 0) {
        continue
      }
      accepted.push(...acceptedForHost)
      pendingWrites.push({ hostId, session: nextSession })
    }
    if (pendingWrites.length > 0) {
      try {
        for (const write of pendingWrites) {
          this.store?.setWorkspaceSession?.(write.session, write.hostId)
        }
        this.store?.flushOrThrow?.()
      } catch (error) {
        console.error('[runtime] failed to persist terminal retirement:', error)
        return null
      }
    }
    return { accepted, unpersisted }
  }

  protected retireMobileSessionSurfacesForPty(
    ptyId: string,
    incarnationId: string,
    exactSurfaces: readonly Pick<RetiredTerminalSurface, 'worktreeId' | 'parentTabId' | 'leafId'>[]
  ): void {
    const retiredSurfaceByKey = new Map<string, RetiredTerminalSurface>()
    for (const surface of exactSurfaces) {
      retiredSurfaceByKey.set(`${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`, {
        ...surface,
        ptyId,
        incarnationId
      })
    }
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId,
        exactSurfaces: exactSurfaces.filter((surface) => surface.worktreeId === worktreeId),
        exactOnly: exactSurfaces.length > 0
      })
      if (!retired) {
        continue
      }
      for (const surface of retired.retired) {
        retiredSurfaceByKey.set(
          `${surface.worktreeId}\0${surface.parentTabId}\0${surface.leafId}`,
          { ...surface, incarnationId }
        )
      }
    }
    const retiredSurfaces = [...retiredSurfaceByKey.values()]
    if (retiredSurfaces.length === 0) {
      return
    }
    const persisted = this.persistTerminalSurfaceRetirements(retiredSurfaces)
    if (!persisted) {
      return
    }
    for (const surface of persisted.unpersisted) {
      const repoId = getRepoIdFromWorktreeId(surface.worktreeId)
      this.terminalTopologyRevisionByRepoId.set(
        repoId,
        (this.terminalTopologyRevisionByRepoId.get(repoId) ?? 0) + 1
      )
    }
    // Why: one repo epoch can cover multiple exits, but only surfaces individually accepted by persistence may disappear.
    const publishableRetiredSurfaces = [...persisted.accepted, ...persisted.unpersisted]
    if (publishableRetiredSurfaces.length === 0) {
      return
    }
    for (const surface of publishableRetiredSurfaces) {
      this.retiredMobileSessionPtyIds.add(surface.ptyId)
    }
    for (const [worktreeId, snapshot] of this.mobileSessionTabsByWorktree) {
      const retired = retireTerminalSurfacesFromSnapshot({
        snapshot,
        ptyId,
        exactSurfaces: publishableRetiredSurfaces.filter(
          (surface) => surface.worktreeId === worktreeId
        ),
        // Why: discovery is broad by PTY id, but publication may remove only surfaces whose durable retirement was accepted.
        exactOnly: true
      })
      if (retired) {
        this.mobileSessionTabsByWorktree.set(worktreeId, retired.snapshot)
        this.notifyMobileSessionTabsChanged(worktreeId)
      }
    }
  }
}
