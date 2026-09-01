import { toRelaySshPtyId } from './ssh-pty-id'
import { SSH_SOURCE_RESTORE_REQUIRED_ERROR } from './ssh-pty-errors'
import type { PtySpawnOptions, PtySpawnResult } from './types'
import {
  reattachSshPtySessionWithExitFence,
  type SshPtyReattachResult
} from './ssh-pty-session-reattach'
import type { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'
import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PtySourceReceivingActivation } from '../../shared/pty-source-receiving-activation'
import type { SshPtyReceivingActivationLease } from './ssh-pty-notification-routing'

type ReattachForSpawnArgs = {
  mux: SshChannelMultiplexer
  connectionId: string
  sessionId: string
  options: PtySpawnOptions
  exitRaceTracker: SshPtySpawnExitRaceTracker
  acceptLivePty: (relayPtyId: string) => void
  rememberPtyIncarnation?: (relayPtyId: string, incarnationId: unknown) => void
  installSourceActivation?: (
    relayPtyId: string,
    activation: PtySourceReceivingActivation
  ) => SshPtyReceivingActivationLease
}

/** Finish a session-id spawn only after the reattach has a usable source. */
export async function reattachSshPtySessionForSpawn(
  args: ReattachForSpawnArgs
): Promise<PtySpawnResult> {
  let result: SshPtyReattachResult | undefined
  try {
    result = await reattachSshPtySessionWithExitFence(args)
    if (result.sourceRecovery?.status === 'restoreRequired') {
      throw new Error(
        `${SSH_SOURCE_RESTORE_REQUIRED_ERROR}: ${toRelaySshPtyId(args.connectionId, result.id)}`
      )
    }
    args.acceptLivePty(result.id)
    result.sourceActivationLease?.commit()
    const { sourceActivationLease: _lease, sourceRecovery: _recovery, ...spawnResult } = result
    return spawnResult
  } catch (error) {
    // Await cancellation so a failed spawn cannot leave the provisional delivery live.
    try {
      await result?.sourceActivationLease?.rollback()
    } catch {
      // Preserve the original reattach failure; rollback is best-effort cleanup.
    }
    throw error
  }
}
