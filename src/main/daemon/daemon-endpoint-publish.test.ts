import type * as NodeFs from 'node:fs'
import {
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
import { getDaemonSocketBindPath, publishDaemonEndpoint } from './daemon-endpoint-ownership'
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
      const probe = async () => {
        linkSync(competitorPath, competitorLink)
        renameSync(competitorPath, canonicalPath)
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
