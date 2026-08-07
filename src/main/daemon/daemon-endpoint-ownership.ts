/* Ownership of the daemon's canonical endpoint name and of the scratch entries the
   rename-claim protocol leaves behind. Kept apart from daemon-spawner so the rule that
   decides who may serve on the socket path is readable on its own. */
import { randomBytes } from 'node:crypto'
import { existsSync, linkSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

export { sweepAbandonedDaemonClaims } from './daemon-endpoint-claim-sweep'

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
export type DaemonEndpointReclaimOutcome =
  /** The entry was proven dead and removed. */
  | 'reclaimed'
  /** Something is serving it; the entry was put back untouched. */
  | 'live-owner'
  /** There was nothing to claim. */
  | 'absent'
  /** Could not be classified; the entry was put back and must be left alone. */
  | 'inconclusive'
  /** The claim is retained because its canonical name could not be restored. */
  | 'restoration-failed'

export async function reclaimDeadDaemonSocketPath(
  socketPath: string,
  probeEndpoint: (path: string) => Promise<'alive' | 'dead' | 'unknown'>
): Promise<DaemonEndpointReclaimOutcome> {
  if (process.platform === 'win32') {
    return 'absent'
  }
  const claimedPath = join(dirname(socketPath), `.c${randomBytes(5).toString('hex')}`)
  try {
    renameSync(socketPath, claimedPath)
  } catch {
    return 'absent'
  }
  // Why tri-state: collapsing this to a boolean makes an unclassifiable probe read as "dead",
  // which deletes an endpoint that may well be serving. Only proof of death may remove it.
  let liveness: 'alive' | 'dead' | 'unknown' = 'unknown'
  try {
    liveness = await probeEndpoint(claimedPath)
  } catch {
    // A failed probe still owes the claimed endpoint its canonical name back.
  }
  if (liveness === 'dead') {
    try {
      unlinkSync(claimedPath)
      return 'reclaimed'
    } catch {
      return restoreClaimedDaemonSocketPath(claimedPath, socketPath)
        ? 'inconclusive'
        : 'restoration-failed'
    }
  }
  if (!restoreClaimedDaemonSocketPath(claimedPath, socketPath)) {
    return 'restoration-failed'
  }
  return liveness === 'alive' ? 'live-owner' : 'inconclusive'
}

/**
 * Puts a claimed entry back without ever overwriting a newer one.
 *
 * Why link and not rename: rename replaces whatever is at the target, so a daemon that
 * published while we held the claim would be silently swapped out for the older entry we
 * took. Link fails with EEXIST instead, which is the correct outcome — the newer publisher
 * owns the name and our claim is simply dropped.
 */
function restoreClaimedDaemonSocketPath(claimedPath: string, socketPath: string): boolean {
  try {
    linkSync(claimedPath, socketPath)
  } catch (error) {
    if (!(isFileExistsError(error) && existsSync(socketPath))) {
      // Keep the sole reachable name for a later recovery attempt.
      return false
    }
  }
  try {
    unlinkSync(claimedPath)
  } catch {
    // A uniquely named leftover is inert and is swept by age.
  }
  return true
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
  // Why claim first: stat-then-unlink is two syscalls, so a replacement publishing between
  // them gets deleted — the same race as third-party reclaim, and reverting to it because
  // inode recycling is impossible here was addressing the wrong failure mode.
  const claimedPath = join(dirname(socketPath), `.c${randomBytes(5).toString('hex')}`)
  try {
    renameSync(socketPath, claimedPath)
  } catch {
    return false
  }
  if (daemonSocketIdentityMatches(readDaemonSocketIdentity(claimedPath), owned)) {
    try {
      unlinkSync(claimedPath)
      return true
    } catch {
      restoreClaimedDaemonSocketPath(claimedPath, socketPath)
      return false
    }
  }
  restoreClaimedDaemonSocketPath(claimedPath, socketPath)
  return false
}
