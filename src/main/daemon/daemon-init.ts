import { fork } from 'node:child_process'
import { releaseDaemonAdoptionLease } from './daemon-adoption-lease'
import { collectPinnedDaemonVersions, pruneOldDaemonHosts } from './daemon-host-relocation'
import { trackDaemonRetired } from './daemon-lifecycle-event'
import { DaemonPtyAdapter, type DaemonRespawnReason } from './daemon-pty-adapter'
import {
  adoptDaemonProvider,
  getAllDaemonAdapters,
  reconcileSeededClaudeLivePtys,
  type DaemonProvider
} from './daemon-provider-adoption'
import { createRestartDaemonAdapter, runDaemonProviderRestart } from './daemon-provider-restart'
import { cleanupDaemonProtocol, discoverLegacyDaemonAdapters } from './daemon-protocol-cleanup'
import { createDaemonProcessLauncher } from './daemon-process-launcher'
import { getDaemonHistoryDir, getDaemonRuntimeDir } from './daemon-runtime-paths'
import {
  DaemonSpawner,
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  type DaemonConnectionInfo
} from './daemon-spawner'
import {
  getMacDaemonTccAttributionHealth,
  type MacDaemonTccAttributionHealth
} from './daemon-tcc-attribution'
import { rebindLocalProviderListeners, setLocalPtyProvider } from '../ipc/pty'
import { isStartupDiagnosticsEnabled, logStartupDiagnostic } from '../startup/startup-diagnostics'
import type { DaemonReplaceReason } from '../../shared/daemon-lifecycle-telemetry'
import type { DaemonFork, DaemonChildProcess } from './daemon-child-process'

export const WEDGED_DAEMON_GRACE_RETRIES = 11

let spawner: DaemonSpawner | null = null
let adapter: DaemonProvider | null = null
let restartInFlight: Promise<RestartDaemonResult> | null = null
let attributedReplaceReason: DaemonReplaceReason | null = null

function logDaemonMilestone(event: string, details: Record<string, unknown> = {}): void {
  if (!isStartupDiagnosticsEnabled()) {
    return
  }
  logStartupDiagnostic(event, { t: Math.round(performance.now()), ...details })
}

const forkDaemon: DaemonFork = (entryPath, args, options) =>
  fork(entryPath, args, options) as unknown as DaemonChildProcess

function takeAttributedReplaceReason(): DaemonReplaceReason | null {
  const reason = attributedReplaceReason
  attributedReplaceReason = null
  return reason
}

function createSpawner(runtimeDir: string, macosLoginSessionWatch: boolean): DaemonSpawner {
  return new DaemonSpawner({
    runtimeDir,
    launcher: createDaemonProcessLauncher(runtimeDir, {
      forkDaemon,
      macosLoginSessionWatch,
      wedgedDaemonGraceRetries: WEDGED_DAEMON_GRACE_RETRIES,
      takeAttributedReplaceReason
    })
  })
}

function createRespawn(
  daemonSpawner: DaemonSpawner
): (reason: DaemonRespawnReason) => Promise<(() => void) | undefined> {
  return async (reason) => {
    if (reason === 'daemon_died') {
      console.warn('[daemon] Daemon process died — respawning')
      if (!restartInFlight) {
        trackDaemonRetired('died_respawn')
      }
    } else {
      attributedReplaceReason = reason
    }
    daemonSpawner.resetHandle()
    await daemonSpawner.ensureRunning()
    const handle = daemonSpawner.getHandle()
    const release = handle?.releaseAdoptionLease
    if (!release || !handle) {
      return undefined
    }
    delete handle.releaseAdoptionLease
    return release
  }
}

function createCurrentAdapter(
  connection: DaemonConnectionInfo,
  runtimeDir: string,
  historyPath: string,
  daemonSpawner: DaemonSpawner
): DaemonPtyAdapter {
  return createRestartDaemonAdapter(
    connection,
    runtimeDir,
    historyPath,
    createRespawn(daemonSpawner)
  )
}

export async function initDaemonPtyProvider(
  signal?: AbortSignal,
  options: { macosLoginSessionWatch?: boolean } = {}
): Promise<void> {
  logDaemonMilestone('daemon-init-start')
  const e2eInitDelayMs = Number(process.env.ORCA_E2E_DAEMON_INIT_DELAY_MS)
  if (Number.isFinite(e2eInitDelayMs) && e2eInitDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, e2eInitDelayMs))
  }

  const runtimeDir = getDaemonRuntimeDir()
  const newSpawner = createSpawner(runtimeDir, options.macosLoginSessionWatch ?? false)
  const connection = await newSpawner.ensureRunning()
  pruneOldDaemonHosts(collectPinnedDaemonVersions(runtimeDir))
  const launchMode = newSpawner.getHandle()?.mode
  logDaemonMilestone('daemon-current-ready')

  if (signal?.aborted) {
    const abortedAdapter = new DaemonPtyAdapter({
      socketPath: connection.socketPath,
      tokenPath: connection.tokenPath,
      pidPath: getDaemonPidPath(runtimeDir),
      profileScope: runtimeDir,
      runtimeDir
    })
    releaseDaemonAdoptionLease(newSpawner.getHandle())
    await abortedAdapter.disconnectOnly()
    return
  }

  const historyPath = getDaemonHistoryDir()

  const adopted = await adoptDaemonProvider({
    spawner: newSpawner,
    connection,
    runtimeDir,
    historyPath,
    launchMode,
    signal,
    createCurrentAdapter: (info) => createCurrentAdapter(info, runtimeDir, historyPath, newSpawner)
  })
  if (!adopted) {
    return
  }

  spawner = newSpawner
  adapter = adopted.provider
  setLocalPtyProvider(adopted.provider)
  rebindLocalProviderListeners()
  logDaemonMilestone('daemon-init-done', { legacyAdapters: adopted.legacyCount })
  await reconcileSeededClaudeLivePtys(adopted.provider)
}

export function getDaemonProvider(): DaemonProvider | null {
  return adapter
}

export async function getCurrentDaemonMacTccAttributionHealth(): Promise<MacDaemonTccAttributionHealth> {
  const runtimeDir = getDaemonRuntimeDir()
  return getMacDaemonTccAttributionHealth(
    runtimeDir,
    getDaemonSocketPath(runtimeDir),
    getDaemonTokenPath(runtimeDir)
  )
}

export async function listLiveDaemonPtyIds(): Promise<string[] | null> {
  if (!adapter) {
    return null
  }
  const inventories = await Promise.allSettled(
    getAllDaemonAdapters(adapter).map((daemonAdapter) => daemonAdapter.listProcesses())
  )
  if (inventories.some((inventory) => inventory.status === 'rejected')) {
    return null
  }
  return inventories.flatMap((inventory) =>
    inventory.status === 'fulfilled' ? inventory.value.map((process) => process.id) : []
  )
}

export function replaceDaemonProvider(newAdapter: DaemonProvider): void {
  adapter = newAdapter
  setLocalPtyProvider(newAdapter)
}

export type RestartDaemonResult = {
  killedCount: number
}

export async function restartDaemon(): Promise<RestartDaemonResult> {
  if (restartInFlight) {
    return restartInFlight
  }
  restartInFlight = runRestartDaemon().finally(() => {
    restartInFlight = null
  })
  return restartInFlight
}

async function runRestartDaemon(): Promise<RestartDaemonResult> {
  const currentSpawner = spawner
  const currentAdapter = adapter
  if (!currentSpawner || !currentAdapter) {
    throw new Error('restartDaemon called before initDaemonPtyProvider')
  }
  const runtimeDir = getDaemonRuntimeDir()
  const historyPath = getDaemonHistoryDir()
  return runDaemonProviderRestart({
    spawner: currentSpawner,
    provider: currentAdapter,
    runtimeDir,
    historyPath,
    createCurrentAdapter: (connection, respawn) =>
      createRestartDaemonAdapter(connection, runtimeDir, historyPath, respawn),
    respawn: createRespawn(currentSpawner),
    replaceProvider: replaceDaemonProvider
  })
}

export async function disconnectDaemon(): Promise<void> {
  await adapter?.disconnectOnly()
  adapter = null
}

export async function shutdownDaemon(): Promise<void> {
  adapter?.dispose()
  adapter = null
  await spawner?.shutdown()
  spawner = null
}

export type OrphanedDaemonCleanupResult = {
  cleaned: boolean
  killedCount: number
}

export async function cleanupDaemonForProtocol(
  runtimeDir: string,
  protocolVersion: number
): Promise<OrphanedDaemonCleanupResult> {
  return cleanupDaemonProtocol(runtimeDir, protocolVersion)
}

export async function createLegacyDaemonAdapters(
  runtimeDir: string,
  historyPath = getDaemonHistoryDir()
): Promise<DaemonPtyAdapter[]> {
  return discoverLegacyDaemonAdapters(runtimeDir, historyPath)
}
