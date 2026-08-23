import { app } from 'electron'
import { isDaemonStaleForCurrentBundle } from './daemon-bundle-staleness'
import { checkDaemonHealth, getMacDaemonSystemResolverHealth } from './daemon-health'
import { getDaemonLaunchIdentity } from './daemon-pid-identity'
import type { DaemonProcessHandle } from './daemon-spawner'
import { getMacDaemonTccAttributionHealth } from './daemon-tcc-attribution'
import { cleanupDaemonProtocol } from './daemon-protocol-cleanup'
import { getAliveDaemonSessionCount, probeDaemonSocket } from './daemon-runtime-probe'
import { PROTOCOL_VERSION } from './types'
import type { trackDaemonReplaced } from './daemon-lifecycle-event'

export type ReplacementEvidence = {
  reason: Parameters<typeof trackDaemonReplaced>[0]
  liveSessionCount: number | null
}

type InspectionResult = {
  handle?: DaemonProcessHandle
  replacement?: ReplacementEvidence
  confirmedReplacement: boolean
}

type InspectDaemonIncumbentOptions = {
  runtimeDir: string
  socketPath: string
  tokenPath: string
  entryPath: string
  wedgedDaemonGraceRetries: number
  preserveDaemon(mode?: 'degraded-new-pty-fallback'): Promise<DaemonProcessHandle>
}

export async function inspectDaemonIncumbent(
  options: InspectDaemonIncumbentOptions
): Promise<InspectionResult> {
  const health = await checkDaemonHealth(options.socketPath, options.tokenPath)
  return health === 'healthy'
    ? inspectHealthyDaemon(options)
    : inspectUnhealthyDaemon(options, health)
}

async function inspectHealthyDaemon(
  options: InspectDaemonIncumbentOptions
): Promise<InspectionResult> {
  const { runtimeDir, socketPath, tokenPath, entryPath, preserveDaemon } = options
  if ((await getMacDaemonSystemResolverHealth(socketPath, tokenPath)) === 'unhealthy') {
    const liveSessionCount = await getAliveDaemonSessionCount(socketPath, tokenPath)
    if (liveSessionCount !== 0) {
      warnPreservedDaemon('with unavailable macOS system resolver', liveSessionCount)
      return preserved(preserveDaemon)
    }
    console.warn('[daemon] Replacing daemon with unavailable macOS system resolver')
    return replacementAfterCleanup(runtimeDir, 'unhealthy_resolver', liveSessionCount)
  }

  const identity = await getDaemonLaunchIdentity(runtimeDir, socketPath, tokenPath, entryPath)
  const staleBundle =
    app.isPackaged &&
    (await isDaemonStaleForCurrentBundle(runtimeDir, socketPath, tokenPath, app.getVersion()))
  if (identity === 'mismatch' || staleBundle) {
    const label = staleBundle
      ? 'launched before the current app bundle was installed'
      : 'launched from a different app path'
    if (await shouldPreserveDaemonWithLiveSessions(socketPath, tokenPath, label)) {
      return preserved(preserveDaemon)
    }
    console.warn(
      staleBundle
        ? '[daemon] Replacing daemon launched before the current app bundle was installed'
        : '[daemon] Replacing daemon launched from a different app path'
    )
    return replacementAfterCleanup(
      runtimeDir,
      staleBundle ? 'stale_bundle' : 'different_app_path',
      0
    )
  }

  if ((await getMacDaemonTccAttributionHealth(runtimeDir, socketPath, tokenPath)) !== 'severed') {
    return preserved(preserveDaemon)
  }
  const liveSessionCount = await getAliveDaemonSessionCount(socketPath, tokenPath)
  if (liveSessionCount !== 0) {
    return preserved(preserveDaemon)
  }
  console.warn(
    '[daemon] Replacing daemon whose macOS TCC attribution is severed (spawning app binary no longer exists)'
  )
  return replacementAfterCleanup(runtimeDir, 'severed_tcc_attribution', liveSessionCount)
}

async function inspectUnhealthyDaemon(
  options: InspectDaemonIncumbentOptions,
  health: Awaited<ReturnType<typeof checkDaemonHealth>>
): Promise<InspectionResult> {
  const { socketPath, tokenPath, preserveDaemon } = options
  let liveSessionCount = await getAliveDaemonSessionCount(socketPath, tokenPath)
  let graceRetry = 0
  while (
    liveSessionCount === null &&
    health !== 'rejected' &&
    graceRetry < options.wedgedDaemonGraceRetries &&
    (await probeDaemonSocket(socketPath))
  ) {
    liveSessionCount = await getAliveDaemonSessionCount(socketPath, tokenPath)
    graceRetry++
  }
  if (liveSessionCount !== null && liveSessionCount > 0) {
    if (health === 'pty-spawn-unhealthy') {
      console.warn(
        `[daemon] DEGRADED MODE: preserving daemon that failed the PTY spawn health check because it owns ${formatLiveSessionCount(liveSessionCount)}. Existing sessions keep working; fresh terminals run on the local provider WITHOUT daemon persistence until you restart the daemon (Manage Sessions → Restart).`
      )
      return preserved(preserveDaemon, 'degraded-new-pty-fallback')
    }
    console.warn(
      `[daemon] Preserving daemon that failed the health check because it owns ${formatLiveSessionCount(liveSessionCount)}`
    )
    return preserved(preserveDaemon)
  }
  if (liveSessionCount !== null || graceRetry > 0 || health === 'rejected') {
    console.warn(
      `[daemon] Replacing daemon that failed the health check (health=${health}, liveSessions=${liveSessionCount ?? 'unverifiable'}, graceRetries=${graceRetry})`
    )
  }
  return {
    replacement: { reason: 'failed_health_check', liveSessionCount },
    confirmedReplacement: false
  }
}

async function replacementAfterCleanup(
  runtimeDir: string,
  reason: ReplacementEvidence['reason'],
  liveSessionCount: number | null
): Promise<InspectionResult> {
  const confirmedReplacement = (await cleanupDaemonProtocol(runtimeDir, PROTOCOL_VERSION)).cleaned
  return { replacement: { reason, liveSessionCount }, confirmedReplacement }
}

async function preserved(
  preserveDaemon: InspectDaemonIncumbentOptions['preserveDaemon'],
  mode?: 'degraded-new-pty-fallback'
): Promise<InspectionResult> {
  return { handle: await preserveDaemon(mode), confirmedReplacement: false }
}

async function shouldPreserveDaemonWithLiveSessions(
  socketPath: string,
  tokenPath: string,
  replacementLabel: string
): Promise<boolean> {
  const liveSessionCount = await getAliveDaemonSessionCount(socketPath, tokenPath)
  if (liveSessionCount === 0) {
    return false
  }
  warnPreservedDaemon(replacementLabel, liveSessionCount)
  return true
}

function warnPreservedDaemon(label: string, liveSessionCount: number | null): void {
  console.warn(
    liveSessionCount === null
      ? `[daemon] Preserving daemon ${label} because live session state could not be verified`
      : `[daemon] Preserving daemon ${label} because it owns ${formatLiveSessionCount(liveSessionCount)}`
  )
}

function formatLiveSessionCount(count: number): string {
  return `${count} live session${count === 1 ? '' : 's'}`
}
