/* Who may serve on the daemon's canonical endpoint name.
   The rule, in one sentence: only a daemon publishing itself onto the endpoint may mutate that
   directory entry, and only by replacing an entry it has itself just proven dead.
   See docs/reference/daemon-endpoint-ownership.md. */
import { randomBytes } from 'node:crypto'
import { linkSync, lstatSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { endpointIsProvenDead, type SocketProbeOutcome } from './daemon-endpoint-probe'

// Why bounded: each attempt is only retried when another publisher demonstrably took the name.
const PUBLISH_ATTEMPTS = 3

/*
 * Why there is no sweeper for the scratch names this file and daemon-spawner create:
 * deciding whether someone else's leftover is safe to delete is the same question this design
 * retired for the endpoint, and answering it produced the same defects — deleting a live
 * listener's only pathname, and deleting a healthy daemon's ownership record mid-claim.
 * Every actor already removes its own scratch name on every non-crash path, so what a sweeper
 * would collect is mostly crash debris. It is not free — the runtime directory is still scanned
 * once per launch by collectPinnedDaemonVersions, and the claim paths tolerate a failed unlink,
 * so leftovers can accumulate slowly even without a crash. But no reader mistakes them for real
 * artifacts, a colliding bind name only fails one listen, and the measured cost stays small at
 * plausible rates — which beats a mechanism that can delete a running process's files.
 * See docs/reference/daemon-endpoint-ownership.md.
 */

/**
 * A daemon endpoint, identified well enough to tell one incarnation from another.
 *
 * The birth time is carried at nanosecond resolution and is not always wanted: it distinguishes a freed-and-recycled inode
 * number from the original, which matters only where the inode could have been freed between the
 * two readings. Where a live listener holds it open, dev+ino is already decisive and comparing
 * birth time only adds risk. The two rules below say which is which.
 */
export type DaemonSocketIdentity = { dev: bigint; ino: bigint }

/**
 * A private, same-directory name to bind before publishing the canonical endpoint.
 *
 * Why `.p` and not the `.b` this used to be: released builds carry a sweeper that matches
 * `^\.b[0-9a-f]{10}$` and unlinks it on age alone, with no liveness check. Deleting our own
 * sweeper does not un-ship theirs — a new daemon paused between bind and publish for longer than
 * their age gate would have its only pathname removed by an old build starting alongside it.
 * Moving the namespace out of their pattern is what actually makes the mixed-version claim true.
 * The length is unchanged, so the `sockaddr_un` budget below is unaffected.
 *
 * Why: `sockaddr_un.sun_path` caps a Unix socket path at ~104 bytes, so this must not extend
 * the canonical path — it replaces the basename with a shorter one, which keeps the bind name
 * strictly shorter than the endpoint the caller already requires to fit.
 */
export function getDaemonSocketBindPath(socketPath: string): string {
  return join(dirname(socketPath), `.p${randomBytes(5).toString('hex')}`)
}

/**
 * The endpoint belongs to someone else. The caller must adopt that daemon rather than fork
 * beside it — a second daemon on a name it cannot reach is exactly the split brain this
 * design exists to prevent.
 */
export class DaemonEndpointUnavailableError extends Error {
  constructor(readonly reason: 'occupied' | 'lost' | 'inconclusive') {
    super(`Daemon endpoint unavailable: ${reason}`)
    this.name = 'DaemonEndpointUnavailableError'
  }
}

/**
 * A live daemon already owns the endpoint, so this one stands down and the launcher should adopt
 * the incumbent. Carried as a process exit code because that is delivered by the same event the
 * launcher settles its wait on, unlike an IPC message, which can lose that race.
 *
 * Why 20 and not a small number: Node reserves 1-13 for its own fatal conditions — 3 is
 * "Internal JavaScript Parse Error", which a corrupt or half-written daemon bundle would exit
 * with. The launcher would then read a daemon that never started as one standing down for a
 * live incumbent, and go off to adopt something that does not exist.
 */
export const DAEMON_EXIT_ENDPOINT_OCCUPIED = 20

/**
 * Refusal sent when a daemon is asked to create a session on an endpoint that no longer resolves
 * to it. Shared so the client's retry allowlist cannot drift from the server's wording — a
 * refusal the client does not recognise dead-ends at the user instead of reconnecting.
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
 * Why bind privately and link rather than bind the canonical name directly: Node/libuv unlinks
 * the pathname a server bound to when that server closes, with no ownership check — a daemon
 * exiting late therefore deleted whichever socket then sat at that path, including a live
 * replacement's. Binding a unique name means libuv can only ever unlink our own bind name.
 *
 * Why link first and rename second: `rename` replaces whatever it finds, so using it
 * unconditionally would let a starting daemon destroy a healthy one's endpoint. `link` fails
 * with EEXIST instead, which forces the liveness question to be asked before anything is
 * replaced — and on the common path it is itself the kernel-enforced exclusive claim.
 */
export async function publishDaemonEndpoint(
  boundPath: string,
  canonicalPath: string,
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome>
): Promise<DaemonEndpointPublishOutcome> {
  if (process.platform === 'win32') {
    // Named pipes are not directory entries; the pipe name itself is exclusive, and a dead
    // daemon's pipe simply ceases to exist. A successful listen is the whole protocol.
    return { status: 'published', identity: null }
  }
  // Why stat the bound name: the link shares the inode, so reading identity here cannot be
  // raced by anything happening to the canonical name. Why it must not fail: without it we
  // could neither verify the publish nor arm the ownership watchdog, so we would serve a name
  // we can never check. Startup has nothing to protect yet, so failing here is the cheap option.
  const identity = readDaemonSocketIdentity(boundPath)
  if (!identity) {
    throw new Error(`Cannot identify the bound daemon endpoint at ${boundPath}`)
  }
  // Why a loop: losing the name to another publisher mid-protocol is not an error, it just
  // invalidates the evidence. Re-running the whole sequence is the correct response, and a
  // small bound keeps a pathological directory from spinning forever.
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt++) {
    try {
      linkSync(boundPath, canonicalPath)
    } catch (error) {
      const noHardLinks = isLinkUnsupportedError(error)
      if (!isFileExistsError(error) && !noHardLinks) {
        throw error
      }
      // Why the same path either way: without hard links we lose `link`'s exclusivity, but not
      // the rest of the protocol. The death proof, the continuity re-check and the post-publish
      // verification all still apply, and it is that verification — absent when this fallback
      // was first removed — that makes replacing an unclaimable name safe rather than a silent
      // overwrite. Two publishers can both rename onto an absent name; the loser sees it.
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
  // Why inconclusive and not occupied: being outrun repeatedly says the name keeps changing
  // hands, not that anything is serving it — no probe ever connected. Reporting a live owner
  // would send the caller off to adopt an endpoint that may by now be dead, and it would lose a
  // perfectly good bound listener to do it. Declining is the honest answer.
  return { status: 'inconclusive' }
}

/**
 * Replaces an occupied endpoint name, but only once nothing can be serving it.
 *
 * Why `rename` and not unlink-then-link: unlink-then-link leaves the canonical name absent
 * between the two calls, and every concurrent observer — a connecting client, another daemon's
 * publish, the ownership watchdog — can land in that gap and conclude something false. Measured
 * across a live handover, rename exposed no gap in thousands of probes where unlink-then-link
 * gapped on essentially every observation.
 */
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

async function replaceProvenDeadEndpoint(
  boundPath: string,
  canonicalPath: string,
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome>,
  absentIsStable: boolean
): Promise<DaemonEndpointPublishOutcome | null | 'evidence-stale'> {
  // Why capture this first: the proof we are about to gather describes one particular entry,
  // and the rename replaces whatever is at the name. Without something to compare, a probe that
  // stalled while another daemon published would license destroying that daemon.
  const proven = readDaemonEndpointEntryIdentity(canonicalPath)
  const outcome = await probeEndpointSafely(canonicalPath, probeEndpoint)
  if (outcome === 'connected') {
    return { status: 'occupied' }
  }
  if (!endpointIsProvenDead(outcome)) {
    // Why: a timed-out or EPERM probe is not a second opinion. Collapsing "could not classify"
    // into "dead" is what deletes an endpoint that is still serving every terminal on the host.
    return { status: 'inconclusive' }
  }
  if (
    !isSameEndpointEntry(proven, readDaemonEndpointEntryIdentity(canonicalPath), absentIsStable)
  ) {
    // The name changed hands while we were probing, so our death proof describes an entry that
    // is no longer there. Start over rather than act on it.
    return 'evidence-stale'
  }
  // Why ask again rather than compare metadata: the entry we proved dead can be unlinked and its
  // inode number handed straight back to a replacement, which then matches on dev+ino and looks
  // like continuity. Birth time was used to tell those apart and cannot be trusted to — it may
  // be the ctime, the epoch, or coarser than the events it must separate. Whether something is
  // serving is the property that actually matters, and connecting answers it directly.
  if (!endpointIsProvenDead(await probeEndpointSafely(canonicalPath, probeEndpoint))) {
    return { status: 'occupied' }
  }
  renameSync(boundPath, canonicalPath)
  // null means "the name is ours now" — the caller still has to confirm it kept it.
  return null
}

/**
 * Same directory entry, by device and inode number.
 *
 * There is deliberately no birth-time term. It was used to distinguish one incarnation of a
 * recycled inode number from another, and it cannot be relied on for that: Node documents the
 * field as sometimes holding the ctime, filesystems without a birth time report the epoch, and
 * granularity is often coarser than the events it would have to separate. Three attempts to
 * patch around those produced three more defects. The recycling case is now settled by asking
 * whether anything is serving the name, which is the property that actually matters.
 */
function isSameInode(a: DaemonSocketIdentity, b: DaemonSocketIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/**
 * Absent-and-still-absent counts as unchanged; one side absent does not.
 *
 * Why the incarnation rule here and not at the post-publish check: the entry being compared is
 * one we believe is dead, so its inode can be freed — and Linux hands the number straight back.
 * A replacement landing on the recycled number would compare equal, and we would rename over a
 * live daemon we never proved dead.
 *
 * Why the ctime hazard is tolerable here: the two readings bracket only a probe, so this code
 * mutates nothing between them. Another process still could, and on a host where the field is
 * really ctime that reads as a change — but the cost of being wrong in that direction is a
 * single retry. That is exactly why the same comparison is wrong at the ownership check, where
 * being wrong retires a daemon that is serving.
 */
function isSameEndpointEntry(
  a: DaemonSocketIdentity | null,
  b: DaemonSocketIdentity | null,
  absentIsStable: boolean
): boolean {
  if (!a || !b) {
    // Why this is a caller's decision: where an entry demonstrably existed, two unreadable stats
    // prove nothing and must not authorise a rename. Where publishing is replacing an absent
    // name because the filesystem has no hard links, absent-then-absent is the stable state we
    // are relying on, and there is nothing there to destroy.
    return absentIsStable && !a && !b
  }
  return isSameInode(a, b)
}

/**
 * Confirms the name we just took is still ours.
 *
 * Why: two daemons can prove the same dead entry dead and both replace it; the second wins.
 * The loser must never serve, because nothing resolves to it. Checking here bounds that window
 * to the gap between two syscalls instead of a watchdog poll — and dev+ino alone is decisive
 * because our own listener still holds the inode open, so its number cannot be recycled while
 * we are asking.
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
    // Why not "published": the name we just took is gone, or we cannot read it. Either way we
    // have no evidence we are reachable, and a starting daemon has no sessions to protect — so
    // declining costs nothing, while serving a name that resolves elsewhere is the whole bug.
    return isMissingFileError(error) ? { status: 'lost' } : { status: 'inconclusive' }
  }
  // Why the fresh reading is recorded and not the one taken before publishing: this identity
  // becomes what the ownership watchdog compares the entry against, and that comparison includes
  // the birth time. Node documents it as sometimes holding the ctime instead — libuv fills
  // it from st_ctim on Linux kernels without statx, or where seccomp blocks it. link and rename
  // both bump ctime, so a pre-publish reading could never match the entry again on such a host,
  // and the daemon would declare itself lost on its first session and stand down for good.
  // dev+ino still bind this to our own inode, so nothing is given up by reading it after.
  // isSameInode, not the incarnation rule: these readings straddle the link or rename that
  // published the name, which bumps ctime — and the birth time may BE ctime. Our own listener holds
  // the inode open, so its number cannot be recycled and dev+ino is decisive on its own.
  return isSameInode(published, identity)
    ? { status: 'published', identity: published }
    : { status: 'lost' }
}

/**
 * Whether `link` failed because the filesystem cannot do it at all, rather than because the name
 * was taken. Some POSIX and FUSE filesystems accept a bound Unix socket and `rename` but refuse
 * hard links; on those, requiring the link would mean no daemon persistence at all.
 */
/**
 * Identity of the directory entry itself, not of whatever it resolves to.
 *
 * Why `lstat` here and `stat` elsewhere: the continuity check asks "is this still the entry I
 * proved dead", and a dangling symlink is an entry — `stat` follows it, fails, and reports the
 * name as absent even though it demonstrably occupies the name. Reading the link itself keeps
 * absent (`ENOENT`) distinct from present-but-unresolvable, which is what the check needs.
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
    // dev+ino, not the incarnation rule: `owned` is this daemon's own bound socket and its
    // listener is still open whenever this runs, so the kernel cannot free that inode or hand
    // its number to anything else. Recycling — the only thing birthtime guards against — is
    // impossible here, while comparing it would add a way to report a false loss if anything
    // bumps our inode's ctime, since the birth time may BE ctime. A false loss is the expensive
    // direction: it is sticky, and it retires a daemon that is serving perfectly well.
    return isSameInode({ dev: stats.dev, ino: stats.ino }, owned) ? 'owned' : 'lost'
  } catch (error) {
    // Why: a stat that failed for any reason other than "the entry is gone" proves nothing.
    // Treating EACCES or EIO as lost ownership would retire a perfectly healthy daemon.
    return isMissingFileError(error) ? 'lost' : 'indeterminate'
  }
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}
