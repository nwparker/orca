import { readFileSync } from 'node:fs'
import { DaemonClient } from './client'
import { readDaemonProcessIncarnation } from './daemon-ready-identity'
import {
  replaceDaemonPidFile,
  type DaemonPidFile,
  type DaemonProcessHandle,
  type DaemonSpawner
} from './daemon-spawner'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'

export class DaemonEndpointOwnershipError extends Error {}

type DaemonEndpointIdentityReader = {
  getDaemonIdentity?: () => DaemonEndpointIdentity | null
}

function readDaemonEndpointIdentity(
  client: DaemonEndpointIdentityReader
): DaemonEndpointIdentity | null {
  return client.getDaemonIdentity?.() ?? null
}

export function createPreservedDaemonHandle(
  shutdown: () => Promise<void>,
  mode?: 'degraded-new-pty-fallback'
): DaemonProcessHandle {
  return mode ? { shutdown, mode } : { shutdown }
}

export async function holdDaemonAdoptionLease(
  handle: DaemonProcessHandle,
  socketPath: string,
  tokenPath: string,
  connectedClient?: DaemonClient,
  expectedIdentity?: DaemonEndpointIdentity,
  pidPath?: string
): Promise<DaemonProcessHandle> {
  const client = connectedClient ?? new DaemonClient({ socketPath, tokenPath })
  try {
    await client.ensureConnected()
    if (expectedIdentity) {
      assertEndpointIdentity(client, expectedIdentity)
    }
    await reconcileDaemonPidOwnership(client, pidPath)
  } catch (error) {
    client.disconnect()
    throw error
  }
  handle.releaseAdoptionLease = () => client.disconnect()
  return handle
}

function assertEndpointIdentity(
  client: DaemonEndpointIdentityReader,
  expected: DaemonEndpointIdentity
): void {
  const actual = readDaemonEndpointIdentity(client)
  if (
    !actual ||
    actual.pid !== expected.pid ||
    actual.startedAtMs !== expected.startedAtMs ||
    actual.launchNonce !== expected.launchNonce
  ) {
    throw new DaemonEndpointOwnershipError('Daemon endpoint ownership changed during startup')
  }
}

export async function reconcileDaemonPidOwnership(
  client: DaemonEndpointIdentityReader,
  pidPath?: string
): Promise<void> {
  const identity = readDaemonEndpointIdentity(client)
  if (!pidPath || !identity || pidRecordMatchesEndpoint(pidPath, identity)) {
    return
  }

  const { pid, startedAtMs, launchNonce } = identity
  const ownerMetadata = await readDaemonOwnerMetadata(identity)
  if (!replaceDaemonPidFile(pidPath, { pid, startedAtMs, launchNonce, ...ownerMetadata })) {
    console.warn(
      '[daemon] Could not repair daemon PID ownership; adopting the authenticated endpoint anyway'
    )
    return
  }
  console.warn('[daemon] Repaired daemon PID ownership to match the authenticated endpoint')
}

async function readDaemonOwnerMetadata(
  identity: DaemonEndpointIdentity
): Promise<Partial<DaemonPidFile>> {
  const metadata: Partial<DaemonPidFile> = {}
  if (identity.entryPath) {
    metadata.entryPath = identity.entryPath
  }
  if (identity.appVersion) {
    metadata.appVersion = identity.appVersion
  }
  if (identity.spawnerExecPath) {
    metadata.spawnerExecPath = identity.spawnerExecPath
  }
  const incarnation = await readDaemonProcessIncarnation(identity.pid)
  if (incarnation) {
    metadata.linuxStartTicks = incarnation.linuxStartTicks
    metadata.bootId = incarnation.bootId
  }
  return metadata
}

function pidRecordMatchesEndpoint(pidPath: string, identity: DaemonEndpointIdentity): boolean {
  try {
    const record = JSON.parse(readFileSync(pidPath, 'utf8')) as {
      pid?: unknown
      startedAtMs?: unknown
      launchNonce?: unknown
    }
    return (
      record.pid === identity.pid &&
      record.startedAtMs === identity.startedAtMs &&
      record.launchNonce === identity.launchNonce
    )
  } catch {
    return false
  }
}

export function releaseDaemonAdoptionLease(handle: DaemonProcessHandle | null): void {
  takeDaemonAdoptionLeaseRelease(handle)?.()
}

export function takeDaemonAdoptionLeaseRelease(
  handle: DaemonProcessHandle | null
): (() => void) | undefined {
  const release = handle?.releaseAdoptionLease
  if (!release || !handle) {
    return undefined
  }
  delete handle.releaseAdoptionLease
  return release
}

export async function cleanupFailedDaemonAdoption(
  failedSpawner: DaemonSpawner,
  current: DaemonPtyAdapter,
  legacy: DaemonPtyAdapter[] = []
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => releaseDaemonAdoptionLease(failedSpawner.getHandle())),
    ...legacy.map((entry) => entry.disconnectOnly()),
    (async () => {
      try {
        await current.disconnectOnly()
      } catch (error) {
        current.dispose()
        throw error
      }
    })()
  ])
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  )
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Daemon adoption cleanup failed')
  }
}
