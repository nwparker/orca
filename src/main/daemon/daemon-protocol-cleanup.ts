import { readFileSync, unlinkSync } from 'node:fs'
import { DaemonEndpointOwnershipError } from './daemon-adoption-lease'
import { DaemonClient } from './client'
import { probeDaemonSocket, waitForDaemonEndpointExit } from './daemon-runtime-probe'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'
import { killStaleDaemon } from './daemon-stale-kill'
import {
  CLEAN_DISCONNECT_PROTOCOL_VERSION,
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  type ListSessionsResult
} from './types'

const DAEMON_SELF_SHUTDOWN_WAIT_MS = 5_000

export type OrphanedDaemonCleanupResult = {
  cleaned: boolean
  killedCount: number
}

export async function cleanupDaemonProtocol(
  runtimeDir: string,
  protocolVersion: number
): Promise<OrphanedDaemonCleanupResult> {
  const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
  const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion)

  if (!(await probeDaemonSocket(socketPath))) {
    if (protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
      return { cleaned: false, killedCount: 0 }
    }
    unlinkBestEffort(pidPath)
    return { cleaned: false, killedCount: 0 }
  }

  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  let killedCount = 0
  let didRequestShutdown = false
  let didKillStaleDaemon = false
  try {
    await client.ensureConnected()
    const sessions = await client
      .request<ListSessionsResult>('listSessions', undefined)
      .catch(() => ({ sessions: [] }))
    killedCount = sessions.sessions.filter((session) => session.isAlive).length
    await client.request('shutdown', { killSessions: true }).catch(() => {})
    didRequestShutdown = true
  } catch {
    const outcome = await killStaleDaemon(runtimeDir, socketPath, tokenPath, protocolVersion)
    didKillStaleDaemon = outcome.killed
    if (outcome.liveOwnerSurvived) {
      throw new DaemonEndpointOwnershipError(
        'Daemon cleanup aborted: the existing daemon could not be confirmed stopped'
      )
    }
  } finally {
    client.disconnect()
  }

  if (didRequestShutdown && protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
    if (!(await waitForDaemonEndpointExit(socketPath, DAEMON_SELF_SHUTDOWN_WAIT_MS))) {
      throw new Error('Timed out waiting for daemon self-shutdown')
    }
    return { cleaned: true, killedCount }
  }

  unlinkBestEffort(pidPath)
  return { cleaned: didRequestShutdown || didKillStaleDaemon, killedCount }
}

function unlinkBestEffort(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Best-effort.
  }
}

function legacyDaemonProcessMayBeAlive(runtimeDir: string, protocolVersion: number): boolean {
  try {
    const parsed = parseDaemonPidFile(
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    )
    if (!parsed) {
      return false
    }
    process.kill(parsed.pid, 0)
    return true
  } catch {
    return false
  }
}

export async function discoverLegacyDaemonAdapters(
  runtimeDir: string,
  historyPath: string
): Promise<DaemonPtyAdapter[]> {
  const adapters: DaemonPtyAdapter[] = []
  for (const protocolVersion of PREVIOUS_DAEMON_PROTOCOL_VERSIONS) {
    const socketPath = getDaemonSocketPath(runtimeDir, protocolVersion)
    const tokenPath = getDaemonTokenPath(runtimeDir, protocolVersion)
    if (!(await probeDaemonSocket(socketPath))) {
      if (!legacyDaemonProcessMayBeAlive(runtimeDir, protocolVersion)) {
        unlinkBestEffort(getDaemonPidPath(runtimeDir, protocolVersion))
        unlinkBestEffort(getDaemonTokenPath(runtimeDir, protocolVersion))
      }
      continue
    }
    adapters.push(
      new DaemonPtyAdapter({
        socketPath,
        tokenPath,
        pidPath: getDaemonPidPath(runtimeDir, protocolVersion),
        profileScope: runtimeDir,
        runtimeDir,
        protocolVersion,
        historyPath
      })
    )
  }
  return adapters
}
