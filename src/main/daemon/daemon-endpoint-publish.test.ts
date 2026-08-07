import type * as NodeFs from 'node:fs'
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getDaemonSocketBindPath,
  publishDaemonEndpoint,
  readDaemonSocketIdentity
} from './daemon-endpoint-ownership'
import { probeSocketConnect } from './daemon-endpoint-probe'

const unixIt = it.skipIf(process.platform === 'win32')

type Listener = { server: Server; connections: () => number }

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-p-'))
}

async function listen(socketPath: string): Promise<Listener> {
  let connectionCount = 0
  const server = createServer((socket) => {
    connectionCount += 1
    socket.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  return { server, connections: () => connectionCount }
}

async function close(server: Server): Promise<void> {
  if (!server.listening) {
    return
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()))
  })
}

async function expectReachable(socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => {
      socket.end()
      resolve()
    })
    socket.once('error', reject)
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
}

async function publishListener(boundPath: string, canonicalPath: string): Promise<void> {
  const outcome = await publishDaemonEndpoint(boundPath, canonicalPath, probeSocketConnect)
  expect(outcome.status).toBe('published')
}

afterEach(() => {
  vi.doUnmock('node:fs')
  vi.resetModules()
})

describe('publishDaemonEndpoint', () => {
  unixIt('publishes a listener when the canonical endpoint is free', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      const outcome = await publishDaemonEndpoint(boundPath, canonicalPath, probeSocketConnect)

      expect(outcome).toMatchObject({ status: 'published' })
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(1)
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('leaves a live incumbent in place', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const incumbentPath = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const incumbent = await listen(incumbentPath)
    const newcomer = await listen(newcomerPath)
    try {
      await publishListener(incumbentPath, canonicalPath)

      const outcome = await publishDaemonEndpoint(newcomerPath, canonicalPath, probeSocketConnect)

      expect(outcome).toEqual({ status: 'occupied' })
      await expectReachable(canonicalPath)
      expect(incumbent.connections()).toBe(2)
      expect(newcomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(incumbent.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('replaces an incumbent that has stopped listening', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const incumbentPath = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const incumbent = await listen(incumbentPath)
    const newcomer = await listen(newcomerPath)
    try {
      await publishListener(incumbentPath, canonicalPath)
      await close(incumbent.server)

      const outcome = await publishDaemonEndpoint(newcomerPath, canonicalPath, probeSocketConnect)

      expect(outcome).toMatchObject({ status: 'published' })
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(1)
    } finally {
      await Promise.all([close(incumbent.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt(
    'never replaces a daemon that published while the death proof was being gathered',
    async () => {
      // Why: the proof describes the entry that was probed, not whatever holds the name by the
      // time we act on it. A publisher stalled between the two would otherwise destroy an
      // established daemon it never proved dead — the original bug, reached by a narrow window.
      const directory = makeTempDir()
      const canonicalPath = join(directory, 'd')
      const stalePath = getDaemonSocketBindPath(canonicalPath)
      const winnerPath = getDaemonSocketBindPath(canonicalPath)
      const latecomerPath = getDaemonSocketBindPath(canonicalPath)
      const stale = await listen(stalePath)
      const winner = await listen(winnerPath)
      const latecomer = await listen(latecomerPath)
      try {
        // A dead entry both publishers will legitimately prove dead.
        await publishListener(stalePath, canonicalPath)
        await close(stale.server)

        // The winner takes the name while the latecomer is still probing the dead entry. Only on
        // the first probe: the retry must see a live incumbent, which is the point.
        const winnerIdentity = readDaemonSocketIdentity(winnerPath)
        let raced = false
        const probe = async (path: string) => {
          const outcome = await probeSocketConnect(path)
          if (!raced) {
            raced = true
            renameSync(winnerPath, canonicalPath)
          }
          return outcome
        }
        const outcome = await publishDaemonEndpoint(latecomerPath, canonicalPath, probe)

        // The latecomer must back off, and the winner must still own a reachable endpoint.
        // Two connections to the winner: the latecomer's retry probe, then expectReachable.
        expect(outcome).toEqual({ status: 'occupied' })
        await expectReachable(canonicalPath)
        expect(winner.connections()).toBe(2)
        expect(latecomer.connections()).toBe(0)
        expect(readDaemonSocketIdentity(canonicalPath)).toEqual(winnerIdentity)
      } finally {
        await Promise.all([close(stale.server), close(winner.server), close(latecomer.server)])
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  unixIt('leaves an incumbent untouched when probing is inconclusive', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const incumbentPath = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const incumbent = await listen(incumbentPath)
    const newcomer = await listen(newcomerPath)
    try {
      await publishListener(incumbentPath, canonicalPath)
      const before = statSync(canonicalPath, { bigint: true })
      const probe = vi.fn(async () => 'unknown' as const)

      const outcome = await publishDaemonEndpoint(newcomerPath, canonicalPath, probe)

      const after = statSync(canonicalPath, { bigint: true })
      expect(outcome).toEqual({ status: 'inconclusive' })
      expect(probe).toHaveBeenCalledWith(canonicalPath)
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: before.dev, ino: before.ino })
      await expectReachable(canonicalPath)
      expect(incumbent.connections()).toBe(1)
      expect(newcomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(incumbent.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('replaces a regular file occupying the endpoint', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      writeFileSync(canonicalPath, 'stale')

      const outcome = await publishDaemonEndpoint(boundPath, canonicalPath, probeSocketConnect)

      expect(outcome).toMatchObject({ status: 'published' })
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(1)
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('replaces a dangling symlink occupying the endpoint', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      symlinkSync(join(directory, 'x'), canonicalPath)

      const outcome = await publishDaemonEndpoint(boundPath, canonicalPath, probeSocketConnect)

      expect(outcome).toMatchObject({ status: 'published' })
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(1)
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('treats a probe that throws as inconclusive rather than as proof of death', async () => {
    // Why: a probe that failed classified nothing. Letting a thrown error fall through to the
    // dead branch would replace an endpoint that may well be serving.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const incumbentPath = getDaemonSocketBindPath(canonicalPath)
    const newcomerPath = getDaemonSocketBindPath(canonicalPath)
    const incumbent = await listen(incumbentPath)
    const newcomer = await listen(newcomerPath)
    try {
      await publishListener(incumbentPath, canonicalPath)
      const before = readDaemonSocketIdentity(canonicalPath)
      const probe = vi.fn(async () => {
        throw new Error('probe blew up')
      })

      const outcome = await publishDaemonEndpoint(newcomerPath, canonicalPath, probe)

      expect(outcome).toEqual({ status: 'inconclusive' })
      expect(readDaemonSocketIdentity(canonicalPath)).toEqual(before)
      await expectReachable(canonicalPath)
      expect(newcomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(incumbent.server), close(newcomer.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('does not replace an entry whose inode number was recycled', async () => {
    // Why birthtime and not just dev+ino here: the entry being compared is one we believe is
    // dead, so its inode can be freed — and Linux hands the number straight back. A replacement
    // landing on the recycled number compares equal and would license the very rename this
    // check exists to prevent. Recycling cannot be provoked on demand, so the identity read is
    // mocked to report the same dev+ino with a later birthtime, which is what recycling looks
    // like. (The post-publish check is the opposite case: there our own listener holds the
    // inode open, so dev+ino alone is sound.)
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      writeFileSync(canonicalPath, 'dead entry')
      const deadEntry = statSync(canonicalPath, { bigint: true })
      let canonicalStats = 0
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        return {
          ...actual,
          statSync: (target: string, options?: { bigint?: boolean }) => {
            const stats = actual.statSync(target, options as never) as unknown as {
              dev: bigint
              ino: bigint
              birthtimeMs: bigint
            }
            if (target !== canonicalPath) {
              return stats
            }
            // Every read reports a later birthtime than the last, so no two consecutive reads
            // of the entry agree — what an inode recycled under us looks like.
            canonicalStats += 1
            return {
              dev: stats.dev,
              ino: stats.ino,
              birthtimeMs: stats.birthtimeMs + BigInt(canonicalStats)
            }
          }
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishWithRecycle } =
        await import('./daemon-endpoint-ownership')

      const outcome = await publishWithRecycle(boundPath, canonicalPath, probeSocketConnect)

      // The publisher must back off rather than replace an entry it cannot still identify.
      expect(outcome).toEqual({ status: 'occupied' })
      const after = statSync(canonicalPath, { bigint: true })
      expect({ dev: after.dev, ino: after.ino }).toEqual({ dev: deadEntry.dev, ino: deadEntry.ino })
      expect(newcomer.connections()).toBe(0)
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('refuses to serve a bound endpoint it cannot identify', async () => {
    // Why: without the bound identity we can neither verify the publish nor arm the ownership
    // watchdog, so we would serve a name we could never check. Startup has nothing to protect.
    const directory = makeTempDir()
    try {
      await expect(
        publishDaemonEndpoint(
          join(directory, '.bmissing'),
          join(directory, 'd'),
          probeSocketConnect
        )
      ).rejects.toThrow(/Cannot identify the bound daemon endpoint/)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('reports lost when the name it took disappears before verification', async () => {
    // Why not 'published': the entry we took is gone, so nothing resolves to this listener.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        return {
          ...actual,
          unlinkSync: (target: string) => {
            actual.unlinkSync(target)
            if (target === boundPath) {
              actual.unlinkSync(canonicalPath)
            }
          }
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishWithRemover } =
        await import('./daemon-endpoint-ownership')

      await expect(
        publishWithRemover(boundPath, canonicalPath, probeSocketConnect)
      ).resolves.toEqual({ status: 'lost' })
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('declines rather than publishes when the endpoint cannot be verified', async () => {
    // Why fail closed: an unreadable canonical entry is not evidence we are reachable, and a
    // starting daemon loses nothing by declining.
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const newcomer = await listen(boundPath)
    try {
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        return {
          ...actual,
          unlinkSync: (target: string) => {
            actual.unlinkSync(target)
            if (target === boundPath) {
              // Drop search permission on the directory so the verifying stat fails EACCES.
              actual.chmodSync(directory, 0o600)
            }
          }
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishWithBlockedStat } =
        await import('./daemon-endpoint-ownership')

      await expect(
        publishWithBlockedStat(boundPath, canonicalPath, probeSocketConnect)
      ).resolves.toEqual({ status: 'inconclusive' })
    } finally {
      chmodSync(directory, 0o700)
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('reports lost when another listener replaces it before verification', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const boundPath = getDaemonSocketBindPath(canonicalPath)
    const competitorPath = getDaemonSocketBindPath(canonicalPath)
    const competitorLink = join(directory, '.r')
    const newcomer = await listen(boundPath)
    const competitor = await listen(competitorPath)
    try {
      writeFileSync(canonicalPath, 'stale')
      vi.doMock('node:fs', async () => {
        const actual = await vi.importActual<typeof NodeFs>('node:fs')
        return {
          ...actual,
          renameSync: (source: string, destination: string) => {
            actual.renameSync(source, destination)
            if (source === boundPath && destination === canonicalPath) {
              actual.renameSync(competitorLink, canonicalPath)
            }
          }
        }
      })
      vi.resetModules()
      const { publishDaemonEndpoint: publishWithRacer } =
        await import('./daemon-endpoint-ownership')
      // Why the competitor only takes the name from inside our own rename: publishing during
      // the probe is caught earlier now, by the pre-rename evidence check. 'lost' is
      // specifically the window between taking the name and verifying we still hold it.
      const probe = async () => {
        linkSync(competitorPath, competitorLink)
        return 'refused' as const
      }

      const outcome = await publishWithRacer(boundPath, canonicalPath, probe)

      expect(outcome).toEqual({ status: 'lost' })
      await expectReachable(canonicalPath)
      expect(competitor.connections()).toBe(1)
      expect(newcomer.connections()).toBe(0)
    } finally {
      await Promise.all([close(newcomer.server), close(competitor.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('propagates link errors other than EEXIST', async () => {
    const directory = makeTempDir()
    const boundPath = join(directory, '.b')
    const canonicalPath = join(directory, 'x', 'd')
    const newcomer = await listen(boundPath)
    try {
      const probe = vi.fn(async () => 'missing' as const)

      await expect(publishDaemonEndpoint(boundPath, canonicalPath, probe)).rejects.toMatchObject({
        code: 'ENOENT'
      })
      expect(probe).not.toHaveBeenCalled()
    } finally {
      await close(newcomer.server)
      rmSync(directory, { recursive: true, force: true })
    }
  })

  unixIt('keeps a replacement reachable after the incumbent closes', async () => {
    const directory = makeTempDir()
    const canonicalPath = join(directory, 'd')
    const incumbentPath = getDaemonSocketBindPath(canonicalPath)
    const replacementPath = getDaemonSocketBindPath(canonicalPath)
    const incumbent = await listen(incumbentPath)
    const replacement = await listen(replacementPath)
    try {
      await publishListener(incumbentPath, canonicalPath)
      await close(incumbent.server)

      const outcome = await publishDaemonEndpoint(
        replacementPath,
        canonicalPath,
        probeSocketConnect
      )

      expect(outcome).toMatchObject({ status: 'published' })
      await expectReachable(canonicalPath)
      expect(replacement.connections()).toBe(1)
    } finally {
      await Promise.all([close(incumbent.server), close(replacement.server)])
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
