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
// Why a budget: each aged bind socket costs a liveness probe that can run to its timeout, and
// one that never classifies is kept and re-probed on every future launch. Without a cap the
// work grows without bound; with one it is spread across launches instead.
const ABANDONED_DAEMON_PROBE_BUDGET = 16

/**
 * Reclaims scratch names left behind by a crash.
 *
 * Why age is not enough on its own: between `listen` and publish, a bind name is the *only*
 * name its daemon has, and an old mtime does not prove the process died — one stopped by a
 * debugger, or caught in a host suspend, is still listening on it. Unlinking that would destroy
 * a live listener's sole reachable name, which is the exact defect class this component exists
 * to remove. So an aged bind socket must be proven dead before it is removed, and an
 * unclassifiable probe counts as alive.
 *
 * Why the probe budget: keeping unclassifiable entries means they are re-probed every launch, so
 * a directory that collects them would otherwise make each sweep slower than the last. Anything
 * over the budget is left for the next launch and reported rather than silently skipped.
 */
export async function sweepAbandonedDaemonClaims(
  runtimeDir: string,
  minAgeMs = ABANDONED_DAEMON_CLAIM_MIN_AGE_MS,
  now = Date.now(),
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome> = probeSocketConnect
): Promise<number> {
  let swept = 0
  let probes = 0
  let deferred = 0
  let entries: string[]
  try {
    entries = readdirSync(runtimeDir)
  } catch {
    return 0
  }
  // Why rotate: the probe budget is spent in iteration order, and readdir order is stable on
  // most filesystems. Sixteen entries that never classify would otherwise consume every budget
  // forever, so genuine debris behind them would never be probed. Starting at a different offset
  // each launch gives every entry a turn.
  const offset = entries.length > 0 ? Math.floor(Math.random() * entries.length) : 0
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[(offset + i) % entries.length] as string
    const bindName = ABANDONED_DAEMON_BIND_PATTERN.test(entry)
    if (!bindName && !ABANDONED_DAEMON_ARTIFACT_CLAIM_PATTERN.test(entry)) {
      continue
    }
    const claimPath = join(runtimeDir, entry)
    try {
      const stats = statSync(claimPath)
      // Why ctime and not mtime: a claim is made by renaming a canonical artifact aside, and
      // rename carries the original mtime over — so a claim on a long-lived token or PID record
      // looks hours old the instant it is taken, and this sweep would delete it out from under
      // the process still validating it. rename does update ctime, so it measures what the age
      // gate actually means: how long this entry has existed under this name.
      if (now - stats.ctimeMs < minAgeMs) {
        continue
      }
      // Why proof of death rather than merely "did not answer": a timeout on a loaded host, or
      // an EPERM, classifies nothing — and this name is the only one its daemon has. Removing on
      // anything short of proof is the same mistake as the third-party reclaim this design
      // retired, just aimed at the bind name instead of the canonical one.
      if (bindName && stats.isSocket()) {
        if (probes >= ABANDONED_DAEMON_PROBE_BUDGET) {
          deferred++
          continue
        }
        probes++
        if (!endpointIsProvenDead(await probeEndpoint(claimPath))) {
          continue
        }
      }
      unlinkSync(claimPath)
      swept++
    } catch {
      // Best-effort; a locked or already-removed claim is retried on a future launch.
    }
  }
  if (deferred > 0) {
    console.warn(
      `[daemon] Deferred ${deferred} aged endpoint claim(s) past this sweep's probe budget`
    )
  }
  return swept
}
