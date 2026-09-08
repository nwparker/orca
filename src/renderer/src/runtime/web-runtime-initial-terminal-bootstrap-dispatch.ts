import { useAppStore } from '../store'
import { createWebRuntimeSessionTerminal } from './web-runtime-session'
import type { WebRuntimeTerminalCreateOutcome } from './web-runtime-session-types'
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
  let outcome: WebRuntimeTerminalCreateOutcome
  try {
    outcome = await createWebRuntimeSessionTerminal({ worktreeId, environmentId, activate: true })
  } catch (error) {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    throw error
  }
  // Why check the outcome: the create reports RPC and network failures as `{ status: 'failed' }`
  // rather than throwing, so the catch above never sees them. Holding the latch on a returned
  // failure would suppress every later auto-seed for this worktree until teardown.
  if (
    outcome.status === 'failed' ||
    Object.hasOwn(useAppStore.getState().tabsByWorktree, worktreeId)
  ) {
    endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
  }
  return true
}
