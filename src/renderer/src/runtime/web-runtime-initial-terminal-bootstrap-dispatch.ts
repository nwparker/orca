import { useAppStore } from '../store'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import {
  beginWebRuntimeInitialTerminalBootstrap,
  endWebRuntimeInitialTerminalBootstrap
} from './web-runtime-initial-terminal-bootstrap'

/**
 * Claim the initial-terminal latch for this environment's worktree, create the terminal, and
 * release the latch only once a mirrored row exists (or on failure, for retry).
 *
 * Why row-conditional and not a plain `.finally`: the snapshot refresh the create awaits can resolve
 * on an empty, unconfirmed frame that leaves no `tabsByWorktree` row. Releasing then would let a
 * later effect re-run seed a second terminal even though the first create succeeded. Holding the
 * latch until a row exists makes the predicate decline on its own; worktree or environment teardown
 * clears it either way. A failed create leaves no terminal, so it releases for a later focus to
 * retry.
 *
 * Returns true when this call owned the create, so the caller can keep its closure-local flag in
 * step; false when another closure already held the latch.
 */
export async function dispatchWebRuntimeInitialTerminalBootstrap(
  environmentId: string,
  worktreeId: string
): Promise<boolean> {
  if (!beginWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)) {
    return false
  }
  try {
    await createWebRuntimeSessionTerminal({ worktreeId, environmentId, activate: true })
  } catch (error) {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    throw error
  }
  if (Object.hasOwn(useAppStore.getState().tabsByWorktree, worktreeId)) {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
  }
  return true
}
