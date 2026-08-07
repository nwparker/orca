import { linkSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const ABANDONED_DAEMON_ARTIFACT_CLAIM_PATTERN =
  /\.(?:cleanup|replace)-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ABANDONED_DAEMON_BIND_PATTERN = /^\.b[0-9a-f]{10}$/
const ABANDONED_DAEMON_ENDPOINT_CLAIM_PATTERN = /^\.c[0-9a-f]{10}$/
const ABANDONED_DAEMON_CLAIM_MIN_AGE_MS = 60 * 60 * 1000

function sameFile(firstPath: string, secondPath: string): boolean {
  try {
    const first = statSync(firstPath)
    const second = statSync(secondPath)
    return first.dev === second.dev && first.ino === second.ino
  } catch {
    return false
  }
}

function recoverEndpointClaim(claimPath: string, socketPath?: string): boolean {
  const stats = statSync(claimPath)
  if (stats.nlink > 1 || !stats.isSocket()) {
    return true
  }
  if (!socketPath) {
    return false
  }
  try {
    linkSync(claimPath, socketPath)
  } catch {
    return sameFile(claimPath, socketPath)
  }
  return true
}

/** Reclaims aged scratch names without deleting the sole link to a claimed endpoint. */
export function sweepAbandonedDaemonClaims(
  runtimeDir: string,
  minAgeMs = ABANDONED_DAEMON_CLAIM_MIN_AGE_MS,
  now = Date.now(),
  socketPath?: string
): number {
  let swept = 0
  let entries: string[]
  try {
    entries = readdirSync(runtimeDir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    const endpointClaim = ABANDONED_DAEMON_ENDPOINT_CLAIM_PATTERN.test(entry)
    if (
      !endpointClaim &&
      !ABANDONED_DAEMON_BIND_PATTERN.test(entry) &&
      !ABANDONED_DAEMON_ARTIFACT_CLAIM_PATTERN.test(entry)
    ) {
      continue
    }
    const claimPath = join(runtimeDir, entry)
    try {
      if (
        now - statSync(claimPath).mtimeMs < minAgeMs ||
        (endpointClaim && !recoverEndpointClaim(claimPath, socketPath))
      ) {
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
