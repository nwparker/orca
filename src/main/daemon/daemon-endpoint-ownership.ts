/* Who may serve on the daemon's canonical endpoint name.
   The rule, in one sentence: only a daemon publishing itself onto the endpoint may mutate that
   directory entry, and only by replacing an entry it has itself just proven dead.
   Rationale, alternatives and measurements: docs/reference/daemon-endpoint-ownership.md. */
import { randomBytes } from 'node:crypto'
import { linkSync, lstatSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { endpointIsProvenDead, type SocketProbeOutcome } from './daemon-endpoint-probe'

// Retried only when another publisher demonstrably took the name, so a small bound suffices.
const PUBLISH_ATTEMPTS = 3

// No sweeper collects the scratch names this file and daemon-spawner create: deciding whether
// someone else's leftover is safe to delete is the question this design retired for the endpoint.
// Every actor removes its own on each non-crash path; see the doc for the measured cost of debris.

/** A daemon endpoint, identified by its directory entry. dev+ino only — see the doc on why. */
export type DaemonSocketIdentity = { dev: bigint; ino: bigint }

/**
 * A private, same-directory name to bind before publishing the canonical endpoint.
 *
 * `.p` rather than the `.b` this used to be: released builds carry a sweeper matching
 * `^\.b[0-9a-f]{10}$` that unlinks on age alone, and deleting our sweeper does not un-ship theirs.
 * Same length, and it replaces the basename rather than extending the path, so the ~104-byte
 * `sockaddr_un.sun_path` budget is unaffected.
 */
export function getDaemonSocketBindPath(socketPath: string): string {
  return join(dirname(socketPath), `.p${randomBytes(5).toString('hex')}`)
}

/**
 * This daemon did not get the endpoint, and `reason` says what the caller may conclude.
 *
 * Only `occupied` establishes that someone else owns it, and only then may the caller adopt rather
 * than fork. `lost` and `inconclusive` establish no owner at all, so the caller must decline —
 * adopting on them once turned an inconclusive probe into a claimed live owner.
 */
export class DaemonEndpointUnavailableError extends Error {
  constructor(readonly reason: 'occupied' | 'lost' | 'inconclusive') {
    super(`Daemon endpoint unavailable: ${reason}`)
    this.name = 'DaemonEndpointUnavailableError'
  }
}

/**
 * A live daemon already owns the endpoint, so this one stands down and the launcher adopts it.
 * Carried as an exit code because the launcher settles its wait on process exit, which an IPC
 * message can lose the race to.
 *
 * 20, not a small number: Node reserves 1-13 — 3 is "Internal JavaScript Parse Error", which a
 * corrupt bundle exits with, and the launcher would read that as a stand-down and adopt nothing.
 */
export const DAEMON_EXIT_ENDPOINT_OCCUPIED = 20

/**
 * Refusal sent when a daemon is asked to create a session on an endpoint that no longer resolves
 * to it. Shared so the client's retry allowlist cannot drift from the server's wording.
 */
export const DAEMON_ENDPOINT_LOST_MESSAGE = 'Daemon no longer owns its endpoint; reconnect'

export type DaemonEndpointPublishOutcome =
  /** The endpoint name is ours. */
  | { status: 'published'; identity: DaemonSocketIdentity | null }
  /** A live daemon owns it. Adopt that daemon; never fork beside it. */
  | { status: 'occupied' }
  /** We published, and another daemon replaced us moments later. We must not serve. */
  | { status: 'lost' }
  /** The incumbent could not be classified, so it must be left alone. */
  | { status: 'inconclusive' }

/**
 * Publishes a bound listener under the canonical endpoint name.
 *
 * Bind privately and link rather than bind the canonical name directly: libuv unlinks the pathname
 * a server bound to when it closes, with no ownership check, so a late-exiting daemon deleted
 * whichever socket then sat there. Binding a unique name means libuv can only unlink our own.
 *
 * Link first and rename second: `rename` replaces whatever it finds, so using it unconditionally
 * would let a starting daemon destroy a healthy one's endpoint. `link` fails with EEXIST instead,
 * forcing the liveness question — and on the common path it is the kernel-enforced exclusive claim.
 */
export async function publishDaemonEndpoint(
  boundPath: string,
  canonicalPath: string,
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome>
): Promise<DaemonEndpointPublishOutcome> {
  if (process.platform === 'win32') {
    // Named pipes are not directory entries; the name itself is exclusive and a dead daemon's
    // pipe ceases to exist, so a successful listen is the whole protocol.
    return { status: 'published', identity: null }
  }
  // Stat the bound name: the link shares the inode, so this reading cannot be raced by anything
  // happening to the canonical name. Failing here is cheap — startup has nothing to protect yet,
  // and without an identity we could neither verify the publish nor arm the watchdog.
  const identity = readDaemonSocketIdentity(boundPath)
  if (!identity) {
    throw new Error(`Cannot identify the bound daemon endpoint at ${boundPath}`)
  }
  // Losing the name mid-protocol is not an error, it just invalidates the evidence; re-run.
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    try {
      linkSync(boundPath, canonicalPath)
    } catch (error) {
      const noHardLinks = isLinkUnsupportedError(error)
      if (!isFileExistsError(error) && !noHardLinks) {
        throw error
      }
      // Same path either way: without hard links we lose `link`'s exclusivity but not the death
      // proof, the continuity re-check, or the post-publish verification — and it is that last
      // one that makes replacing an unclaimable name safe rather than a silent overwrite.
      const blocked = await replaceProvenDeadEndpoint(
        boundPath,
        canonicalPath,
        probeEndpoint,
        noHardLinks
      )
      if (blocked === 'evidence-stale') {
        continue
      }
      return blocked ?? confirmPublishedEndpoint(canonicalPath, identity)
    }
    try {
      unlinkSync(boundPath)
    } catch {
      // Inert: clients resolve the canonical link, and the bind name is unique to us.
    }
    return confirmPublishedEndpoint(canonicalPath, identity)
  }
  // Inconclusive, not occupied: being outrun repeatedly says the name keeps changing hands, not
  // that anything is serving it — no probe ever connected.
  return { status: 'inconclusive' }
}

/** A probe that threw classified nothing, which is never proof of death. */
async function probeEndpointSafely(
  canonicalPath: string,
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome>
): Promise<SocketProbeOutcome> {
  try {
    return await probeEndpoint(canonicalPath)
  } catch {
    return 'unknown'
  }
}

/**
 * Replaces an occupied endpoint name, but only once nothing can be serving it.
 *
 * `rename`, not unlink-then-link: the latter leaves the name absent between the two calls, and
 * every concurrent observer can land in that gap and conclude something false. Measured across a
 * live handover, rename exposed no gap where unlink-then-link gapped on nearly every observation.
 */
async function replaceProvenDeadEndpoint(
  boundPath: string,
  canonicalPath: string,
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome>,
  absentIsStable: boolean
): Promise<DaemonEndpointPublishOutcome | null | 'evidence-stale'> {
  // Captured first: the rename replaces whatever is at the name, so without something to compare,
  // a probe that stalled while another daemon published would license destroying that daemon.
  const proven = readDaemonEndpointEntryIdentity(canonicalPath)
  const outcome = await probeEndpointSafely(canonicalPath, probeEndpoint)
  if (outcome === 'connected') {
    return { status: 'occupied' }
  }
  if (!endpointIsProvenDead(outcome)) {
    // A timed-out or EPERM probe is not a second opinion. Collapsing "could not classify" into
    // "dead" is what deletes an endpoint still serving every terminal on the host.
    return { status: 'inconclusive' }
  }
  if (
    !isSameEndpointEntry(proven, readDaemonEndpointEntryIdentity(canonicalPath), absentIsStable)
  ) {
    // The name changed hands while we probed, so the death proof describes an entry that is gone.
    return 'evidence-stale'
  }
  // Ask again rather than compare metadata: the entry we proved dead can be unlinked and its inode
  // number handed straight back to a replacement, which then matches on dev+ino and looks like
  // continuity. Whether something is serving is the property that matters, and connecting answers
  // it directly — birth time, which this used to rely on, cannot.
  const stillDead = await probeEndpointSafely(canonicalPath, probeEndpoint)
  if (stillDead === 'connected') {
    return { status: 'occupied' }
  }
  if (!endpointIsProvenDead(stillDead)) {
    // Same three-way split as the first probe: 'occupied' would send the launcher off to adopt a
    // daemon that may not exist, where 'inconclusive' declines — which is what was established.
    return { status: 'inconclusive' }
  }
  renameSync(boundPath, canonicalPath)
  // null means "the name is ours now" — the caller still has to confirm it kept it.
  return null
}

/**
 * Same directory entry, by device and inode number.
 *
 * No birth-time term: Node documents the field as sometimes holding the ctime, filesystems without
 * one report the epoch, and its granularity is often coarser than the events it must separate.
 */
function isSameInode(a: DaemonSocketIdentity, b: DaemonSocketIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/**
 * Absent-and-still-absent counts as unchanged; one side absent does not.
 *
 * The entry compared here is one we believe is dead, so its inode can be freed and Linux hands the
 * number straight back — a replacement landing on it would compare equal and we would rename over
 * a live daemon. Being wrong in the other direction costs one retry, which is why this comparison
 * is safe here and wrong at the ownership check, where it would retire a daemon that is serving.
 */
function isSameEndpointEntry(
  a: DaemonSocketIdentity | null,
  b: DaemonSocketIdentity | null,
  absentIsStable: boolean
): boolean {
  if (!a || !b) {
    // The caller's call: where an entry demonstrably existed, two unreadable stats prove nothing.
    // Where we are replacing an absent name because the filesystem has no hard links,
    // absent-then-absent is the stable state we rely on, and there is nothing there to destroy.
    return absentIsStable && !a && !b
  }
  return isSameInode(a, b)
}

/**
 * Confirms the name we just took is still ours.
 *
 * Two daemons can prove the same dead entry dead and both replace it; the second wins, and the
 * loser must never serve. Checking here bounds that window to two syscalls instead of a watchdog
 * poll — and dev+ino is decisive because our listener holds the inode open while we ask.
 */
function confirmPublishedEndpoint(
  canonicalPath: string,
  identity: DaemonSocketIdentity
): DaemonEndpointPublishOutcome {
  let published: DaemonSocketIdentity | null = null
  try {
    const stats = statSync(canonicalPath, { bigint: true })
    published = { dev: stats.dev, ino: stats.ino }
  } catch (error) {
    // Not "published": the name is gone or unreadable, so we have no evidence we are reachable.
    return isMissingFileError(error) ? { status: 'lost' } : { status: 'inconclusive' }
  }
  // The fresh reading, not the pre-publish one: this becomes what the watchdog compares against,
  // so it must describe the entry as it now stands rather than as it was before the link/rename.
  return isSameInode(published, identity)
    ? { status: 'published', identity: published }
    : { status: 'lost' }
}

/**
 * Identity of the directory entry itself, not of whatever it resolves to.
 *
 * `lstat` here and `stat` elsewhere: a dangling symlink occupies the name, but `stat` follows it,
 * fails, and reports the name as absent — which would read as "changed hands" to the check above.
 */
function readDaemonEndpointEntryIdentity(socketPath: string): DaemonSocketIdentity | null {
  if (process.platform === 'win32') {
    return null
  }
  try {
    const stats = lstatSync(socketPath, { bigint: true })
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return null
  }
}

/**
 * Whether `link` failed because the filesystem cannot do it at all, rather than because the name
 * was taken. Some POSIX and FUSE filesystems accept a bound socket and `rename` but refuse hard
 * links; requiring the link there would mean no daemon persistence at all.
 */
function isLinkUnsupportedError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false
  }
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'ENOTSUP' || code === 'ENOSYS'
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
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return null
  }
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
    // dev+ino, not the incarnation rule: `owned` is this daemon's own socket and its listener is
    // open whenever this runs, so the kernel cannot recycle that inode number while we ask. A
    // false loss is the expensive direction — it is sticky, and it retires a healthy daemon.
    return isSameInode({ dev: stats.dev, ino: stats.ino }, owned) ? 'owned' : 'lost'
  } catch (error) {
    // A stat that failed for any reason other than "the entry is gone" proves nothing; treating
    // EACCES or EIO as lost ownership would retire a perfectly healthy daemon.
    return isMissingFileError(error) ? 'lost' : 'indeterminate'
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
