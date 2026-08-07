/* Who may serve on the daemon's canonical endpoint name.
   The rule, in one sentence: only a daemon publishing itself onto the endpoint may mutate that
   directory entry, and only by replacing an entry it has itself just proven dead.
   See docs/reference/daemon-endpoint-ownership.md. */
import { randomBytes } from 'node:crypto'
import { linkSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { endpointIsProvenDead, type SocketProbeOutcome } from './daemon-endpoint-probe'

export { sweepAbandonedDaemonClaims } from './daemon-endpoint-claim-sweep'

/**
 * The exact endpoint a daemon owns. `birthtimeMs` is not redundant: Linux reuses inode numbers
 * as soon as the inode is freed, so dev+ino alone will happily match a replacement socket that
 * landed on the recycled number — the entry we must never mistake for our own.
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
  // raced by anything happening to the canonical name.
  const identity = readDaemonSocketIdentity(boundPath)
  try {
    linkSync(boundPath, canonicalPath)
  } catch (error) {
    if (!isFileExistsError(error)) {
      throw error
    }
    const blocked = await replaceProvenDeadEndpoint(boundPath, canonicalPath, probeEndpoint)
    if (blocked) {
      return blocked
    }
    return confirmPublishedEndpoint(canonicalPath, identity)
  }
  try {
    unlinkSync(boundPath)
  } catch {
    // Inert: clients resolve the canonical link, and the bind name is unique to us.
  }
  return confirmPublishedEndpoint(canonicalPath, identity)
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
async function replaceProvenDeadEndpoint(
  boundPath: string,
  canonicalPath: string,
  probeEndpoint: (path: string) => Promise<SocketProbeOutcome>
): Promise<DaemonEndpointPublishOutcome | null> {
  let outcome: SocketProbeOutcome = 'unknown'
  try {
    outcome = await probeEndpoint(canonicalPath)
  } catch {
    // A probe that threw classified nothing, which is not proof of death.
  }
  if (outcome === 'connected') {
    return { status: 'occupied' }
  }
  if (!endpointIsProvenDead(outcome)) {
    // Why: a timed-out or EPERM probe is not a second opinion. Collapsing "could not classify"
    // into "dead" is what deletes an endpoint that is still serving every terminal on the host.
    return { status: 'inconclusive' }
  }
  renameSync(boundPath, canonicalPath)
  // null means "the name is ours now" — the caller still has to confirm it kept it.
  return null
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
  identity: DaemonSocketIdentity | null
): DaemonEndpointPublishOutcome {
  const published = readDaemonSocketIdentity(canonicalPath)
  if (!identity || !published) {
    // Nothing to compare against; the ownership watchdog remains the backstop.
    return { status: 'published', identity }
  }
  return published.dev === identity.dev && published.ino === identity.ino
    ? { status: 'published', identity }
    : { status: 'lost' }
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
