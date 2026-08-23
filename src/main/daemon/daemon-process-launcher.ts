import { randomUUID } from 'node:crypto'
import { DaemonClient } from './client'
import {
  createPreservedDaemonHandle,
  DaemonEndpointOwnershipError,
  holdDaemonAdoptionLease,
  reconcileDaemonPidOwnership
} from './daemon-adoption-lease'
import { DaemonEndpointOccupiedError, launchDaemonChild } from './daemon-child-startup'
import type { DaemonFork } from './daemon-child-process'
import { trackDaemonReplaced } from './daemon-lifecycle-event'
import { inspectDaemonIncumbent, type ReplacementEvidence } from './daemon-launch-incumbent'
import { getDaemonPidPath, type DaemonLauncher, type DaemonProcessHandle } from './daemon-spawner'
import { killStaleDaemon } from './daemon-stale-kill'
import { cleanupDaemonProtocol } from './daemon-protocol-cleanup'
import { probeDaemonSocket } from './daemon-runtime-probe'
import { getDaemonEntryPath } from './daemon-runtime-paths'
import { PROTOCOL_VERSION } from './types'
import type { DaemonReplaceReason } from '../../shared/daemon-lifecycle-telemetry'

type CreateDaemonLauncherOptions = {
  forkDaemon: DaemonFork
  macosLoginSessionWatch: boolean
  wedgedDaemonGraceRetries: number
  takeAttributedReplaceReason(): DaemonReplaceReason | null
}

export function createDaemonProcessLauncher(
  runtimeDir: string,
  options: CreateDaemonLauncherOptions
): DaemonLauncher {
  return async (socketPath, tokenPath, suppliedPidPath, suppliedLaunchNonce) => {
    const entryPath = getDaemonEntryPath()
    const pidPath = suppliedPidPath ?? getDaemonPidPath(runtimeDir)
    const launchNonce = suppliedLaunchNonce ?? randomUUID()
    const attributedReason = options.takeAttributedReplaceReason()
    let pendingReplacement: ReplacementEvidence | undefined
    let confirmedReplacement = false
    let adoptionClient = await connectForAdoption(socketPath, tokenPath, pidPath)
    const preserveDaemon = async (
      mode?: 'degraded-new-pty-fallback'
    ): Promise<DaemonProcessHandle> => {
      const connectedClient = adoptionClient ?? undefined
      adoptionClient = null
      return holdDaemonAdoptionLease(
        createPreservedDaemonHandle(
          async () => void (await cleanupDaemonProtocol(runtimeDir, PROTOCOL_VERSION)),
          mode
        ),
        socketPath,
        tokenPath,
        connectedClient,
        undefined,
        pidPath
      )
    }

    try {
      const inspection = await inspectDaemonIncumbent({
        runtimeDir,
        socketPath,
        tokenPath,
        entryPath,
        wedgedDaemonGraceRetries: options.wedgedDaemonGraceRetries,
        preserveDaemon
      })
      if (inspection.handle) {
        return inspection.handle
      }
      pendingReplacement = inspection.replacement
      confirmedReplacement = inspection.confirmedReplacement

      adoptionClient?.disconnect()
      adoptionClient = null
      const killOutcome = await killStaleDaemon(runtimeDir, socketPath, tokenPath)
      if (killOutcome.liveOwnerSurvived) {
        console.warn(
          '[daemon] DEGRADED MODE: adopting a daemon that could not be confirmed stopped. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).'
        )
        try {
          return await preserveDaemon('degraded-new-pty-fallback')
        } catch {
          throw new DaemonEndpointOwnershipError(
            'Daemon replacement aborted: the existing daemon could not be confirmed stopped'
          )
        }
      }
      confirmedReplacement = killOutcome.killed || confirmedReplacement
      reportReplacement(pendingReplacement, confirmedReplacement, attributedReason)

      let launched
      try {
        launched = await launchDaemonChild({
          forkDaemon: options.forkDaemon,
          entryPath,
          socketPath,
          tokenPath,
          pidPath,
          launchNonce,
          macosLoginSessionWatch: options.macosLoginSessionWatch
        })
      } catch (error) {
        if (!(error instanceof DaemonEndpointOccupiedError)) {
          throw error
        }
        console.warn(
          '[daemon] Endpoint was taken by another daemon during startup — adopting it instead'
        )
        return await holdDaemonAdoptionLease(
          createPreservedDaemonHandle(
            async () => void (await cleanupDaemonProtocol(runtimeDir, PROTOCOL_VERSION))
          ),
          socketPath,
          tokenPath,
          undefined,
          undefined,
          pidPath
        )
      }

      try {
        return await holdDaemonAdoptionLease(
          launched.handle,
          socketPath,
          tokenPath,
          undefined,
          launched.identity,
          pidPath
        )
      } catch (error) {
        if (error instanceof DaemonEndpointOwnershipError) {
          await launched.handle.shutdown()
          launched.removeOwnedPidRecord()
        } else {
          launched.watchPidRecordUntilExit()
        }
        throw error
      }
    } catch (error) {
      adoptionClient?.disconnect()
      adoptionClient = null
      if (await probeDaemonSocket(socketPath)) {
        console.warn(
          '[daemon] DEGRADED MODE: adopting the daemon that owns the endpoint after a replacement could not publish onto it. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).'
        )
        try {
          return await preserveDaemon('degraded-new-pty-fallback')
        } catch {
          // It stopped answering between the probe and adoption.
        }
      }
      throw error
    }
  }
}

async function connectForAdoption(
  socketPath: string,
  tokenPath: string,
  pidPath: string
): Promise<DaemonClient | null> {
  const client = new DaemonClient({ socketPath, tokenPath })
  try {
    await client.ensureConnected()
    await reconcileDaemonPidOwnership(client, pidPath)
    return client
  } catch {
    client.disconnect()
    return null
  }
}

function reportReplacement(
  pending: ReplacementEvidence | undefined,
  confirmed: boolean,
  attributed: DaemonReplaceReason | null
): void {
  const identified =
    pending && confirmed && pending.reason !== 'failed_health_check' ? pending : null
  if (identified) {
    trackDaemonReplaced(identified.reason, identified.liveSessionCount)
  } else if (attributed) {
    trackDaemonReplaced(attributed, 0)
  } else if (pending && confirmed) {
    trackDaemonReplaced(pending.reason, pending.liveSessionCount)
  }
}
