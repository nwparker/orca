// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveKnownWorkspaceFileTarget } from './orca-runtime-resolve-known-workspace-file-target'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'

export class OrcaRuntimeWithInvalidateAllHandlesForPty extends OrcaRuntimeWithResolveKnownWorkspaceFileTarget {
  protected invalidateAllHandlesForPty(ptyId: string): void {
    const incarnationHandle = this.handleByPtyIncarnation.get(ptyId)?.handle
    const preallocatedHandle = this.handleByPtyId.get(ptyId)
    this.invalidatePtyIncarnationHandle(ptyId)
    this.handleByPtyId.delete(ptyId)
    const invalidated = new Set<string>()
    if (preallocatedHandle && preallocatedHandle !== incarnationHandle) {
      invalidated.add(preallocatedHandle)
    }
    for (const [handle, record] of this.handles) {
      if (record.ptyId === ptyId) {
        invalidated.add(handle)
      }
    }
    for (const handle of invalidated) {
      this.handles.delete(handle)
      this.syntheticTerminalHandles.delete(handle)
      this.rejectWaitersForHandle(handle, 'terminal_handle_stale')
    }
    for (const [leafKey, handle] of this.handleByLeafKey) {
      if (invalidated.has(handle)) {
        this.handleByLeafKey.delete(leafKey)
      }
    }
  }

  protected replaceSyntheticTerminalHandlesForRestoredPty(
    ptyId: string,
    controllerHandle: string
  ): boolean {
    const boundHandles = new Set<string>()
    const directHandle = this.handleByPtyId.get(ptyId)
    if (directHandle) {
      boundHandles.add(directHandle)
    }
    for (const [handle, record] of this.handles) {
      if (record.ptyId === ptyId) {
        boundHandles.add(handle)
      } else if (handle === controllerHandle) {
        return false
      }
    }
    for (const [otherPtyId, handle] of this.handleByPtyId) {
      if (otherPtyId !== ptyId && handle === controllerHandle) {
        return false
      }
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const handle = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (handle) {
        boundHandles.add(handle)
      }
    }
    if (
      boundHandles.size === 0 ||
      [...boundHandles].some(
        (handle) => handle === controllerHandle || !this.syntheticTerminalHandles.has(handle)
      )
    ) {
      return false
    }
    this.invalidateAllHandlesForPty(ptyId)
    return true
  }

  // Why: adoption is best-effort restart recovery and must be first-wins.
  // Re-keying a pty that already has a handle this session would strand
  // waiters registered under the old handle, and provider-reported values
  // are not trusted to be collision-free — a handle bound to a different
  // pty must never be stolen by a later report.
  protected isTerminalHandleAdoptionBlocked(ptyId: string, handle: string): boolean {
    if (this.handleByPtyId.get(ptyId) ?? this.findHandleForPtyRecord(ptyId)) {
      return true
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      const issued = this.handleByLeafKey.get(this.getLeafKey(leaf.tabId, leaf.leafId))
      if (issued && issued !== handle) {
        return true
      }
    }
    const existingRecord = this.handles.get(handle)
    if (existingRecord && existingRecord.ptyId !== ptyId) {
      return true
    }
    for (const [otherPtyId, otherHandle] of this.handleByPtyId) {
      if (otherHandle === handle && otherPtyId !== ptyId) {
        return true
      }
    }
    return false
  }

  onPtySpawned(
    ptyId: string,
    incarnationId?: PtyIncarnationId,
    options: { awaitsRegistration?: boolean } = {}
  ): void {
    this.ptyLivenessVerdictByPtyId.delete(ptyId)
    this.stopRequestedPtyIds.delete(ptyId)
    this.retiredMobileSessionPtyIds.delete(ptyId)
    if (options.awaitsRegistration !== false) {
      // Why: surface absence cannot distinguish an in-flight admission from a completed headless lifecycle.
      this.pendingPtyRegistrationIncarnations.set(ptyId, incarnationId ?? null)
    }
    this.terminalViewSubscribers.markSpawnPublished(ptyId)
    const pty = this.getOrCreatePtyWorktreeRecord(ptyId)
    if (pty) {
      if (incarnationId) {
        pty.incarnationId = incarnationId
      }
      pty.connected = true
      pty.disconnectedAt = null
    }
    for (const leaf of this.getLeavesForPty(ptyId)) {
      leaf.connected = true
      leaf.writable = this.graphStatus === 'ready'
      this.adoptPreAllocatedHandle(leaf)
    }
  }
}
