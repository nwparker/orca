// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import { OrcaRuntimeWithResolveTerminalSplitSourceAuthority } from './orca-runtime-resolve-terminal-split-source-authority'
import {
  runtimeWorktreeIdentityKey,
  runtimeWorktreeIdsEqual
} from './runtime-worktree-path-identity'
import { teardownRpcDeadline } from './worktree-teardown'
import type { RuntimeWorktreeTerminalSleepResult } from '../../shared/runtime-types'
import { waitForWorktreeTerminalMutation } from './worktree-terminal-mutation-wait'

export class OrcaRuntimeWithStopTerminalsForWorktree extends OrcaRuntimeWithResolveTerminalSplitSourceAuthority {
  async stopTerminalsForWorktree(
    worktreeSelector: string,
    options: {
      deadline?: number
      stopPty?: (
        ptyId: string,
        stop: () => boolean | Promise<boolean>
      ) => Promise<{ stopped: boolean; owner: boolean }>
      /** Authoritative id for an orphan whose selector no longer resolves. */
      resolvedWorktreeId?: string
      resolvedConnectionId?: string
      resolvedRuntimeEnvironmentId?: string
    } = {}
  ): Promise<{ stopped: number }> {
    // Why: this mutates live PTYs, so reject while the graph is reloading rather than act on cached leaf ownership.
    const graphEpoch = this.captureReadyGraphEpoch()
    const worktree = options.resolvedWorktreeId
      ? { id: options.resolvedWorktreeId }
      : await this.resolveWorktreeSelector(worktreeSelector)
    this.assertStableReadyGraph(graphEpoch)
    if (options.deadline !== undefined && Date.now() >= options.deadline) {
      return { stopped: 0 }
    }
    // Preserve folder-instance suffixes while normalizing cross-platform path spelling.
    const ownsWorktree = options.resolvedWorktreeId
      ? (candidate: string | undefined): boolean =>
          candidate ? runtimeWorktreeIdsEqual(candidate, worktree.id) : false
      : (candidate: string | undefined): boolean => candidate === worktree.id
    const ownsHost = (ptyId: string, connectionId?: string | null): boolean => {
      if (options.resolvedRuntimeEnvironmentId !== undefined) {
        return ptyId.startsWith(
          `remote:${encodeURIComponent(options.resolvedRuntimeEnvironmentId)}@@`
        )
      }
      return (
        options.resolvedConnectionId === undefined || connectionId === options.resolvedConnectionId
      )
    }
    const ptyIds = new Set<string>()
    for (const leaf of this.leaves.values()) {
      if (
        ownsWorktree(leaf.worktreeId) &&
        leaf.ptyId &&
        ownsHost(leaf.ptyId, this.ptysById.get(leaf.ptyId)?.connectionId)
      ) {
        ptyIds.add(leaf.ptyId)
      }
    }
    for (const pty of this.ptysById.values()) {
      if (ownsWorktree(pty.worktreeId) && pty.connected && ownsHost(pty.ptyId, pty.connectionId)) {
        ptyIds.add(pty.ptyId)
      }
    }

    let stopped = 0
    for (const ptyId of ptyIds) {
      if (options.deadline !== undefined && Date.now() >= options.deadline) {
        break
      }
      const stop = (): boolean | Promise<boolean> => {
        if (options.deadline !== undefined && Date.now() >= options.deadline) {
          return false
        }
        if (options.stopPty) {
          // Why: destructive worktree cleanup must not let its cross-surface
          // dedupe treat fire-and-forget controller.kill as physical exit.
          // Why: the RPC deadline makes shutdown/list RPCs settle before the sweep
          // deadline so a wedged daemon yields the accurate stop failure; no deadline
          // (non-destructive) keeps the provider default RPC timeout.
          if (options.deadline !== undefined) {
            return (
              this.ptyController?.stopAndWait?.(ptyId, {
                deadlineMs: teardownRpcDeadline(options.deadline)
              }) ?? false
            )
          }
          return this.ptyController?.stopAndWait?.(ptyId) ?? false
        }
        return Boolean(this.ptyController?.kill(ptyId))
      }
      const stopResult = options.stopPty
        ? await options.stopPty(ptyId, stop)
        : { stopped: stop(), owner: true }
      if (stopResult.owner && stopResult.stopped) {
        stopped += 1
      }
    }
    return { stopped }
  }

  async sleepTerminalsForWorktree(
    worktreeSelector: string
  ): Promise<RuntimeWorktreeTerminalSleepResult> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    const existing = this.terminalSleepByWorktreeId.get(worktree.id)
    if (existing) {
      return await existing
    }

    const sleeping = this.sleepResolvedWorktreeTerminals(worktree)
    this.terminalSleepByWorktreeId.set(worktree.id, sleeping)
    try {
      return await sleeping
    } finally {
      if (this.terminalSleepByWorktreeId.get(worktree.id) === sleeping) {
        this.terminalSleepByWorktreeId.delete(worktree.id)
      }
    }
  }

  async acquireWorktreeTerminalSpawn(worktreeId?: string): Promise<() => void> {
    if (!worktreeId) {
      return () => {}
    }
    const release = await this.acquireWorktreeTerminalMutation(worktreeId)
    const key = runtimeWorktreeIdentityKey(worktreeId)
    const sleepState = this.terminalSleepStateByWorktreeId.get(key)
    if (sleepState?.phase === 'sleeping' || sleepState?.phase === 'partial') {
      this.terminalSleepStateByWorktreeId.delete(key)
      this.emitClientEvent({
        type: 'worktreeTerminalSleepState',
        worktreeId: sleepState.worktreeId,
        generation: sleepState.generation,
        phase: 'woken',
        ptyIds: sleepState.ptyIds,
        terminalHandles: sleepState.terminalHandles
      })
    }
    return release
  }

  protected async acquireWorktreeTerminalMutation(
    worktreeId: string,
    deadline?: number
  ): Promise<() => void> {
    const key = runtimeWorktreeIdentityKey(worktreeId)
    const previous = this.terminalMutationTailByWorktreeId.get(key) ?? Promise.resolve()
    let releaseCurrent = (): void => {}
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve
    })
    const tail = previous.catch(() => {}).then(() => current)
    this.terminalMutationTailByWorktreeId.set(key, tail)
    try {
      await waitForWorktreeTerminalMutation(
        previous.catch(() => {}),
        deadline
      )
    } catch (error) {
      // Why: resolve this abandoned queue node now so it can never acquire later and stop a terminal after the caller timed out.
      releaseCurrent()
      void tail.finally(() => {
        if (this.terminalMutationTailByWorktreeId.get(key) === tail) {
          this.terminalMutationTailByWorktreeId.delete(key)
        }
      })
      throw error
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      releaseCurrent()
      void tail.finally(() => {
        if (this.terminalMutationTailByWorktreeId.get(key) === tail) {
          this.terminalMutationTailByWorktreeId.delete(key)
        }
      })
    }
  }
}
