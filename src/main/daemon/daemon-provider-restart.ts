import { app } from 'electron'
import { rebindLocalProviderListeners, unbindLocalProviderListeners } from '../ipc/pty'
import { cleanupFailedDaemonAdoption, releaseDaemonAdoptionLease } from './daemon-adoption-lease'
import { DaemonPtyAdapter, type DaemonRespawnReason } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { cleanupDaemonProtocol } from './daemon-protocol-cleanup'
import {
  disposeProviderSubscriptionsOnly,
  getCurrentDaemonAdapter,
  getLegacyDaemonAdapters,
  type DaemonProvider
} from './daemon-provider-adoption'
import { getDaemonPidPath, type DaemonConnectionInfo, type DaemonSpawner } from './daemon-spawner'
import { PROTOCOL_VERSION } from './types'

export type RestartDaemonResult = {
  killedCount: number
}

type RestartDaemonOptions = {
  spawner: DaemonSpawner
  provider: DaemonProvider
  runtimeDir: string
  historyPath: string
  createCurrentAdapter(
    connection: DaemonConnectionInfo,
    respawn: (reason: DaemonRespawnReason) => Promise<(() => void) | undefined>
  ): DaemonPtyAdapter
  respawn(reason: DaemonRespawnReason): Promise<(() => void) | undefined>
  replaceProvider(provider: DaemonProvider): void
}

export async function runDaemonProviderRestart(
  options: RestartDaemonOptions
): Promise<RestartDaemonResult> {
  const { provider: previous, spawner, runtimeDir } = options
  const current = getCurrentDaemonAdapter(previous)
  const legacy = getLegacyDaemonAdapters(previous)

  const fallbackKilledCount =
    previous instanceof DegradedDaemonPtyProvider ? await previous.shutdownFallbackSessions() : 0
  const degradedSessionIds =
    previous instanceof DegradedDaemonPtyProvider ? previous.getCurrentDaemonSessionIds() : []
  const killedCount =
    new Set([...current.getActiveSessionIds(), ...degradedSessionIds]).size + fallbackKilledCount
  current.fanoutSyntheticExits(-1)
  if (previous instanceof DegradedDaemonPtyProvider) {
    previous.fanoutCurrentDaemonSyntheticExits(-1)
  }

  unbindLocalProviderListeners()
  let connection: DaemonConnectionInfo
  try {
    await cleanupDaemonProtocol(runtimeDir, PROTOCOL_VERSION)
    spawner.resetHandle()
    connection = await spawner.ensureRunning()
  } catch (error) {
    rebindLocalProviderListeners()
    throw error
  }

  const newCurrent = options.createCurrentAdapter(connection, options.respawn)
  let replacement: DaemonProvider = newCurrent
  try {
    await newCurrent.establishLifecycleLease()
    releaseDaemonAdoptionLease(spawner.getHandle())
    replacement =
      legacy.length > 0 ? new DaemonPtyRouter({ current: newCurrent, legacy }) : newCurrent
    if (replacement instanceof DaemonPtyRouter) {
      await replacement.discoverLegacySessions()
    }
  } catch (error) {
    let cleanupError: unknown
    try {
      if (replacement instanceof DaemonPtyRouter) {
        replacement.disposeRouterOnly()
      }
      await cleanupFailedDaemonAdoption(spawner, newCurrent)
    } catch (caught) {
      cleanupError = caught
    }
    rebindLocalProviderListeners()
    if (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Daemon restart and cleanup both failed')
    }
    throw error
  }

  disposeProviderSubscriptionsOnly(previous)
  options.replaceProvider(replacement)
  rebindLocalProviderListeners()
  return { killedCount }
}

export function createRestartDaemonAdapter(
  connection: DaemonConnectionInfo,
  runtimeDir: string,
  historyPath: string,
  respawn: (reason: DaemonRespawnReason) => Promise<(() => void) | undefined>
): DaemonPtyAdapter {
  return new DaemonPtyAdapter({
    socketPath: connection.socketPath,
    tokenPath: connection.tokenPath,
    pidPath: getDaemonPidPath(runtimeDir),
    profileScope: runtimeDir,
    runtimeDir,
    packagedAppVersion: process.platform === 'darwin' && app.isPackaged ? app.getVersion() : null,
    historyPath,
    respawn
  })
}
