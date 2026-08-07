import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import {
  endpointIsProvenDead,
  probeSocketConnect,
  type SocketProbeOutcome
} from './daemon-endpoint-probe'

const ABANDONED_DAEMON_ARTIFACT_CLAIM_PATTERN =
  /\.(?:cleanup|replace)-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ABANDONED_DAEMON_BIND_PATTERN = /^\.b[0-9a-f]{10}$/
const ABANDONED_DAEMON_CLAIM_MIN_AGE_MS = 60 * 60 * 1000

/**
 * Reclaims scratch names left behind by a crash.
 *
 * Why age is not enough on its own: between `listen` and publish, a bind name is the *only*
 * name its daemon has, and an old mtime does not prove the process died — one stopped by a
 * debugger, or caught in a host suspend, is still listening on it. Unlinking that would destroy
 * a live listener's sole reachable name, which is the exact defect class this component exists
 * to remove. So an aged bind socket is asked whether anything answers before it is removed.
 */
export async function sweepAbandonedDaemonClaims(
  runtimeDir: string,
  minAgeMs = ABANDONED_DAEMON_CLAIM_MIN_AGE_MS,
  now = Date.now(),
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome> = probeSocketConnect
): Promise<number> {
  let swept = 0
  let entries: string[]
  try {
    entries = readdirSync(runtimeDir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const bindName = ABANDONED_DAEMON_BIND_PATTERN.test(entry)
    if (!bindName && !ABANDONED_DAEMON_ARTIFACT_CLAIM_PATTERN.test(entry)) {
      continue
    }
    const claimPath = join(runtimeDir, entry)
    try {
      const stats = statSync(claimPath)
      if (now - stats.mtimeMs < minAgeMs) {
        continue
      }
      // Why proof of death rather than merely "did not answer": a timeout on a loaded host, or
      // an EPERM, classifies nothing — and this name is the only one its daemon has. Removing on
      // anything short of proof is the same mistake as the third-party reclaim this design
      // retired, just aimed at the bind name instead of the canonical one.
      if (bindName && stats.isSocket() && !endpointIsProvenDead(await probeEndpoint(claimPath))) {
        continue
      }
      unlinkSync(claimPath)
      swept++
    } catch {
      // Best-effort; a locked or already-removed claim is retried on a future launch.
    }
  }
  return swept
}
