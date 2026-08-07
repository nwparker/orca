import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const ABANDONED_DAEMON_ARTIFACT_CLAIM_PATTERN =
  /\.(?:cleanup|replace)-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ABANDONED_DAEMON_BIND_PATTERN = /^\.b[0-9a-f]{10}$/
const ABANDONED_DAEMON_CLAIM_MIN_AGE_MS = 60 * 60 * 1000

/**
 * Reclaims scratch names left behind by a crash.
 *
 * Why age alone is enough: a bind name exists only between `listen` and publish, which is
 * milliseconds, and libuv unlinks it when a cleanly-exiting daemon closes. An hour-old one
 * belongs to a process that died in that window. Nothing here is ever the sole reachable name
 * of a live endpoint — publishing consumes the bind name by link or by rename.
 */
export function sweepAbandonedDaemonClaims(
  runtimeDir: string,
  minAgeMs = ABANDONED_DAEMON_CLAIM_MIN_AGE_MS,
  now = Date.now()
): number {
  let swept = 0
  let entries: string[]
  try {
    entries = readdirSync(runtimeDir)
  } catch {
    return 0
  }
  for (const entry of entries) {
    if (
      !ABANDONED_DAEMON_BIND_PATTERN.test(entry) &&
      !ABANDONED_DAEMON_ARTIFACT_CLAIM_PATTERN.test(entry)
    ) {
      continue
    }
    const claimPath = join(runtimeDir, entry)
    try {
      if (now - statSync(claimPath).mtimeMs < minAgeMs) {
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
