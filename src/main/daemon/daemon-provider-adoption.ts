import {
  confirmSeededClaudeLivePtys,
  hasSeededUnconfirmedClaudePtys
} from '../claude-accounts/live-pty-gate'
import { getLocalPtyProvider } from '../ipc/pty'
import { cleanupFailedDaemonAdoption, releaseDaemonAdoptionLease } from './daemon-adoption-lease'
import { checkDaemonHealth } from './daemon-health'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'
import { DaemonPtyRouter } from './daemon-pty-router'
import { DegradedDaemonPtyProvider } from './degraded-daemon-pty-provider'
import { discoverLegacyDaemonAdapters } from './daemon-protocol-cleanup'
import type { DaemonConnectionInfo, DaemonSpawner } from './daemon-spawner'

export type DaemonProvider = DaemonPtyRouter | DaemonPtyAdapter | DegradedDaemonPtyProvider

type AdoptDaemonProviderOptions = {
  spawner: DaemonSpawner
  connection: DaemonConnectionInfo
  runtimeDir: string
  historyPath: string
  launchMode?: 'degraded-new-pty-fallback'
  signal?: AbortSignal
  createCurrentAdapter(connection: DaemonConnectionInfo): DaemonPtyAdapter
}

export async function adoptDaemonProvider(
  options: AdoptDaemonProviderOptions
): Promise<{ provider: DaemonProvider; legacyCount: number } | null> {
  const current = options.createCurrentAdapter(options.connection)
  let legacy: DaemonPtyAdapter[] = []
  let provider: DaemonProvider = current
  try {
    await current.establishLifecycleLease()
    releaseDaemonAdoptionLease(options.spawner.getHandle())
    legacy = await discoverLegacyDaemonAdapters(options.runtimeDir, options.historyPath)
    provider = createRoutedProvider(current, legacy, options.connection, options.launchMode)
    if (provider instanceof DegradedDaemonPtyProvider) {
      await provider.discoverDaemonSessions()
    } else if (provider instanceof DaemonPtyRouter) {
      await provider.discoverLegacySessions()
    }
    if (options.signal?.aborted) {
      await provider.disconnectOnly()
      return null
    }
  } catch (error) {
    try {
      await cleanupFailedDaemonAdoption(options.spawner, current, legacy)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Daemon adoption and cleanup both failed')
    }
    throw error
  }
  return { provider, legacyCount: legacy.length }
}

function createRoutedProvider(
  current: DaemonPtyAdapter,
  legacy: DaemonPtyAdapter[],
  connection: DaemonConnectionInfo,
  launchMode?: 'degraded-new-pty-fallback'
): DaemonProvider {
  if (launchMode === 'degraded-new-pty-fallback') {
    return new DegradedDaemonPtyProvider({
      current,
      legacy,
      fallback: getLocalPtyProvider(),
      probeCurrentDaemonSpawn: async () =>
        (await checkDaemonHealth(connection.socketPath, connection.tokenPath)) === 'healthy'
    })
  }
  return legacy.length > 0 ? new DaemonPtyRouter({ current, legacy }) : current
}

export async function reconcileSeededClaudeLivePtys(provider: DaemonProvider): Promise<void> {
  if (!hasSeededUnconfirmedClaudePtys()) {
    return
  }
  try {
    const adapters = getAllDaemonAdapters(provider)
    const results = await Promise.allSettled(adapters.map((entry) => entry.listSessions()))
    if (results.some((result) => result.status === 'rejected')) {
      console.warn('[daemon] Keeping seeded Claude live-PTY gate — session listing failed')
      return
    }
    confirmSeededClaudeLivePtys(
      results.flatMap((result) =>
        result.status === 'fulfilled' ? result.value.map((session) => session.sessionId) : []
      )
    )
  } catch (error) {
    console.warn('[daemon] Failed to reconcile seeded Claude live-PTY gate:', error)
  }
}

export function getAllDaemonAdapters(provider: DaemonProvider): DaemonPtyAdapter[] {
  return provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider
    ? [...provider.getAllAdapters()]
    : [provider]
}

export function getCurrentDaemonAdapter(provider: DaemonProvider): DaemonPtyAdapter {
  return provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider
    ? provider.getCurrentAdapter()
    : provider
}

export function getLegacyDaemonAdapters(provider: DaemonProvider): DaemonPtyAdapter[] {
  return provider instanceof DaemonPtyRouter || provider instanceof DegradedDaemonPtyProvider
    ? [...provider.getLegacyAdapters()]
    : []
}

export function disposeProviderSubscriptionsOnly(provider: DaemonProvider): void {
  if (provider instanceof DaemonPtyRouter) {
    provider.disposeRouterOnly()
  }
  if (provider instanceof DegradedDaemonPtyProvider) {
    provider.disposeProviderOnly()
  }
}
