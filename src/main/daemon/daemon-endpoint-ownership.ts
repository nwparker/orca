/* Ownership of the daemon's canonical endpoint name and of the scratch entries the
   rename-claim protocol leaves behind. Kept apart from daemon-spawner so the rule that
   decides who may serve on the socket path is readable on its own. */
import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * The exact endpoint a daemon owns. `birthtimeMs` is not redundant: Linux reuses inode
 * numbers as soon as the inode is freed, so dev+ino alone will happily match a replacement
 * socket that landed on the recycled number, which is the entry we must never remove.
 */
export type DaemonSocketIdentity = { dev: bigint; ino: bigint; birthtimeMs: number }

/**
 * A private, same-directory name to bind before publishing the canonical endpoint.
 *
 * Why: `sockaddr_un.sun_path` caps a Unix socket path at ~104 bytes, so this must not extend
 * the canonical path — it replaces the basename with a shorter one, which keeps the bind name
 * strictly shorter than the endpoint the caller already requires to fit.
 */
export function getDaemonSocketBindPath(socketPath: string): string {
  return join(dirname(socketPath), `.b${randomBytes(5).toString('hex')}`)
}

/**
 * Publishes a bound listener under the canonical endpoint name.
 *
 * Why: Node/libuv unlinks the pathname a server bound to when that server closes,
 * with no ownership check — a daemon exiting late therefore deletes whichever socket
 * currently sits at that path, including a live replacement's. Binding a unique path
 * and hard-linking it into place instead means libuv only ever unlinks the private
 * bind name, and the exclusive link doubles as the kernel-enforced endpoint claim.
 */
export function publishDaemonSocketPath(
  boundPath: string,
  canonicalPath: string
): DaemonSocketIdentity | null {
  if (process.platform === 'win32') {
    // Named pipes are not directory entries; the pipe name itself is exclusive.
    return null
  }
  // Why: stat the bound name first — the link shares the inode, so a racing unlink of the
  // canonical name cannot erase our identity and leave the endpoint unwatched and uncleanable.
  const identity = readDaemonSocketIdentity(boundPath)
  try {
    linkSync(boundPath, canonicalPath)
  } catch (error) {
    if (isFileExistsError(error)) {
      throw error
    }
    // Why: a filesystem without hard links must not stop the daemon from starting. Rename
    // still moves the bind name out from under libuv, which preserves the property that
    // matters most — a late close cannot delete a replacement's endpoint. Exclusivity
    // degrades to check-then-act here, which is no weaker than binding the path directly.
    if (existsSync(canonicalPath)) {
      throw error
    }
    renameSync(boundPath, canonicalPath)
    return identity
  }
  try {
    unlinkSync(boundPath)
  } catch {
    // Inert: clients resolve the canonical link, and the bind name is unique to us.
  }
  return identity
}

function isFileExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

export function readDaemonSocketIdentity(socketPath: string): DaemonSocketIdentity | null {
  if (process.platform === 'win32') {
    return null
  }
  try {
    const stats = statSync(socketPath, { bigint: true })
    return { dev: stats.dev, ino: stats.ino, birthtimeMs: Number(stats.birthtimeMs) }
  } catch {
    return null
  }
}

export function daemonSocketIdentityMatches(
  a: DaemonSocketIdentity | null,
  b: DaemonSocketIdentity | null
): boolean {
  return (
    a !== null &&
    b !== null &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.birthtimeMs === b.birthtimeMs
  )
}

/** 'indeterminate' is deliberately distinct from 'lost': only positive evidence may retire a daemon. */
export type DaemonEndpointOwnershipState = 'owned' | 'lost' | 'indeterminate'

export function readDaemonEndpointOwnershipState(
  socketPath: string,
  owned: DaemonSocketIdentity | null
): DaemonEndpointOwnershipState {
  if (process.platform === 'win32' || !owned) {
    return 'indeterminate'
  }
  try {
    const stats = statSync(socketPath, { bigint: true })
    return stats.dev === owned.dev &&
      stats.ino === owned.ino &&
      Number(stats.birthtimeMs) === owned.birthtimeMs
      ? 'owned'
      : 'lost'
  } catch (error) {
    // Why: a stat that failed for any reason other than "the entry is gone" proves nothing.
    // Treating EACCES or EIO as lost ownership would retire a perfectly healthy daemon.
    return isMissingFileError(error) ? 'lost' : 'indeterminate'
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/**
 * Reclaims a canonical endpoint name on behalf of a daemon that is not us.
 *
 * Why liveness rather than identity: the inode we meant to remove has already been freed, and
 * Linux hands the same inode number straight back to the next socket — `birthtimeMs` is often
 * unavailable there too, so identity can silently match a live replacement. What actually
 * distinguishes a dead endpoint from a live one is whether anything answers it. Renaming
 * claims the entry atomically first; connecting through the claimed name still reaches the
 * original listener, because the binding is to the inode, not to the name.
 */
export async function reclaimDeadDaemonSocketPath(
  socketPath: string,
  isEndpointAlive: (path: string) => Promise<boolean>
): Promise<boolean> {
  if (process.platform === 'win32') {
    return false
  }
  const claimedPath = join(dirname(socketPath), `.c${randomBytes(5).toString('hex')}`)
  try {
    renameSync(socketPath, claimedPath)
  } catch {
    return false
  }
  if (!(await isEndpointAlive(claimedPath))) {
    try {
      unlinkSync(claimedPath)
      return true
    } catch {
      return false
    }
  }
  // Something is serving it after all. Put it back and leave it alone.
  restoreClaimedDaemonSocketPath(claimedPath, socketPath)
  return false
}

/**
 * Why the narrow predicate: only a confirmed EEXIST with a canonical entry present proves a
 * replacement won the name. Any other failure means the restore did not happen, and dropping
 * the claim then would destroy the endpoint rather than hand it over.
 */
function restoreClaimedDaemonSocketPath(claimedPath: string, socketPath: string): void {
  try {
    linkSync(claimedPath, socketPath)
  } catch (error) {
    if (!(isFileExistsError(error) && existsSync(socketPath))) {
      // Restore failed and nobody replaced it — a rename cannot fail on an absent target,
      // and keeping the claim on disk is better than deleting the only copy.
      try {
        renameSync(claimedPath, socketPath)
      } catch {
        // Leave the claim in place for the age-gated sweep rather than losing the endpoint.
      }
      return
    }
  }
  try {
    unlinkSync(claimedPath)
  } catch {
    // A uniquely named leftover is inert and is swept by age.
  }
}

/**
 * Removes the canonical endpoint name only while it still resolves to our own listener.
 *
 * Why the rename: checking identity and then unlinking are two syscalls, and no amount of
 * re-checking between them is atomic — a replacement publishing in the gap gets deleted.
 * Renaming claims the directory entry in one operation, so from that point nobody else's
 * entry can be at the canonical path. Only then is it safe to inspect what we took: ours
 * gets dropped, anyone else's gets linked back, and a replacement that published while we
 * held the claim wins the restore by EEXIST.
 */
export function unlinkOwnedDaemonSocketPath(
  socketPath: string,
  owned: DaemonSocketIdentity | null
): boolean {
  if (process.platform === 'win32' || !owned) {
    return false
  }
  // Safe here precisely because the caller still holds the socket open: a bound inode cannot
  // be freed, so its number cannot be recycled under us the way a dead endpoint's can.
  if (!daemonSocketIdentityMatches(readDaemonSocketIdentity(socketPath), owned)) {
    return false
  }
  try {
    unlinkSync(socketPath)
    return true
  } catch {
    return false
  }
}

const ABANDONED_DAEMON_CLAIM_PATTERN =
  /(?:\.(?:cleanup|replace)-\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|^\.[bc][0-9a-f]{10})$/

const ABANDONED_DAEMON_CLAIM_MIN_AGE_MS = 60 * 60 * 1000

/**
 * Reclaims claim/bind scratch names left behind when a rename-claim or bind publish
 * could not remove its own temporary entry. Age-gated so a claim in flight is never touched.
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
    if (!ABANDONED_DAEMON_CLAIM_PATTERN.test(entry)) {
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
