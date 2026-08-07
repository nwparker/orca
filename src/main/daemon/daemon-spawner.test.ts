import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, connect, type Server } from 'node:net'
import {
  DaemonSpawner,
  getDaemonPidPath,
  getDaemonSocketPath,
  getDaemonTokenPath,
  publishDaemonPidFile,
  replaceDaemonPidFile,
  restoreClaimedDaemonArtifact
} from './daemon-spawner'
import {
  getDaemonSocketBindPath,
  publishDaemonEndpoint,
  readDaemonSocketIdentity,
  sweepAbandonedDaemonClaims
} from './daemon-endpoint-ownership'
import { probeSocketConnect } from './daemon-endpoint-probe'
import { startDaemon, type DaemonHandle } from './daemon-main'
import { DaemonClient } from './client'
import type { SubprocessHandle } from './session'
import { PROTOCOL_VERSION } from './types'

function createTestDir(): string {
  return mkdtempSync(join(tmpdir(), 'daemon-spawner-test-'))
}

function createMockSubprocess(): SubprocessHandle {
  let onExitCb: ((code: number) => void) | null = null
  return {
    pid: 88888,
    getForegroundProcess: vi.fn(() => null),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => setTimeout(() => onExitCb?.(0), 5)),
    forceKill: vi.fn(() => setTimeout(() => onExitCb?.(137), 5)),
    signal: vi.fn(),
    onData(_cb: (data: string) => void) {},
    onExit(cb: (code: number) => void) {
      onExitCb = cb
    },
    dispose: vi.fn()
  }
}

describe('DaemonSpawner', () => {
  let dir: string
  let spawner: DaemonSpawner
  let activeDaemons: DaemonHandle[]

  beforeEach(() => {
    dir = createTestDir()
    activeDaemons = []
  })

  afterEach(async () => {
    await spawner?.shutdown()
    for (const d of activeDaemons) {
      await d.shutdown().catch(() => {})
    }
    rmSync(dir, { recursive: true, force: true })
  })

  function createSpawner(): DaemonSpawner {
    spawner = new DaemonSpawner({
      runtimeDir: dir,
      launcher: async (socketPath, tokenPath) => {
        const handle = await startDaemon({
          socketPath,
          tokenPath,
          spawnSubprocess: () => createMockSubprocess()
        })
        activeDaemons.push(handle)
        return { shutdown: () => handle.shutdown() }
      }
    })
    return spawner
  }

  describe('ensureRunning', () => {
    it('passes the scoped PID path and a fresh launch nonce to the launcher', async () => {
      const launcher = vi.fn(async () => ({ shutdown: vi.fn(async () => {}) }))
      spawner = new DaemonSpawner({ runtimeDir: dir, launcher })

      await spawner.ensureRunning()

      expect(launcher).toHaveBeenCalledWith(
        getDaemonSocketPath(dir),
        getDaemonTokenPath(dir),
        getDaemonPidPath(dir),
        expect.stringMatching(/^[0-9a-f-]{36}$/)
      )
    })

    it('uses protocol-scoped socket and token paths', () => {
      const socketPath = getDaemonSocketPath(dir)
      const tokenPath = getDaemonTokenPath(dir)
      const pidPath = getDaemonPidPath(dir)

      if (process.platform === 'win32') {
        expect(socketPath).toContain(`orca-terminal-host-v${PROTOCOL_VERSION}`)
      } else {
        expect(socketPath).toBe(join(dir, `daemon-v${PROTOCOL_VERSION}.sock`))
      }
      expect(tokenPath).toBe(join(dir, `daemon-v${PROTOCOL_VERSION}.token`))
      expect(pidPath).toBe(join(dir, `daemon-v${PROTOCOL_VERSION}.pid`))
    })

    it('starts daemon and returns connection info', async () => {
      const s = createSpawner()
      const info = await s.ensureRunning()

      if (process.platform === 'win32') {
        expect(info.socketPath).toContain(`orca-terminal-host-v${PROTOCOL_VERSION}`)
      } else {
        expect(info.socketPath).toContain(dir)
      }
      expect(info.tokenPath).toContain(dir)
    })

    it('returns same info on subsequent calls', async () => {
      const s = createSpawner()
      const info1 = await s.ensureRunning()
      const info2 = await s.ensureRunning()

      expect(info1.socketPath).toBe(info2.socketPath)
      expect(info1.tokenPath).toBe(info2.tokenPath)
    })

    it('daemon is connectable after ensureRunning', async () => {
      const s = createSpawner()
      const info = await s.ensureRunning()

      const client = new DaemonClient({
        socketPath: info.socketPath,
        tokenPath: info.tokenPath
      })
      await client.ensureConnected()
      expect(client.isConnected()).toBe(true)
      client.disconnect()
    })

    it('daemon can create sessions', async () => {
      const s = createSpawner()
      const info = await s.ensureRunning()

      const client = new DaemonClient({
        socketPath: info.socketPath,
        tokenPath: info.tokenPath
      })
      await client.ensureConnected()

      const result = await client.request<{ isNew: boolean }>('createOrAttach', {
        sessionId: 'test-session',
        cols: 80,
        rows: 24
      })
      expect(result.isNew).toBe(true)
      client.disconnect()
    })
  })

  describe('shutdown', () => {
    it('stops the daemon', async () => {
      const s = createSpawner()
      const info = await s.ensureRunning()
      await s.shutdown()

      const client = new DaemonClient({
        socketPath: info.socketPath,
        tokenPath: info.tokenPath
      })
      await expect(client.ensureConnected()).rejects.toThrow()
    })

    it('can be called when daemon is not running', async () => {
      const s = createSpawner()
      await expect(s.shutdown()).resolves.toBeUndefined()
    })

    it('allows re-start after shutdown', async () => {
      const s = createSpawner()
      await s.ensureRunning()
      await s.shutdown()

      const info = await s.ensureRunning()
      const client = new DaemonClient({
        socketPath: info.socketPath,
        tokenPath: info.tokenPath
      })
      await client.ensureConnected()
      expect(client.isConnected()).toBe(true)
      client.disconnect()
    })
  })
})

describe('restoreClaimedDaemonArtifact', () => {
  it('retains the unique claim when restoration fails without a replacement', () => {
    expect(
      restoreClaimedDaemonArtifact('/claimed', '/canonical', {
        copyExclusive: () => {
          throw new Error('injected ENOSPC')
        },
        canonicalExists: () => false
      })
    ).toBe(false)
  })

  it('retains the unique claim when a failed copy leaves a partial canonical file', () => {
    const restoreDir = createTestDir()
    const canonicalPath = join(restoreDir, 'partial-canonical')
    try {
      expect(
        restoreClaimedDaemonArtifact('/claimed', canonicalPath, {
          copyExclusive: () => {
            writeFileSync(canonicalPath, 'partial')
            throw Object.assign(new Error('injected ENOSPC'), { code: 'ENOSPC' })
          },
          canonicalExists: () => true
        })
      ).toBe(false)
    } finally {
      rmSync(restoreDir, { recursive: true, force: true })
    }
  })

  it('allows claim cleanup after successful restore or a confirmed replacement', () => {
    expect(
      restoreClaimedDaemonArtifact('/claimed', '/canonical', {
        copyExclusive: () => {},
        canonicalExists: () => false
      })
    ).toBe(true)
    expect(
      restoreClaimedDaemonArtifact('/claimed', '/canonical', {
        copyExclusive: () => {
          throw Object.assign(new Error('injected EEXIST'), { code: 'EEXIST' })
        },
        canonicalExists: () => true
      })
    ).toBe(true)
  })
})

describe('daemon PID publication', () => {
  it('publishes ownership exclusively', () => {
    const dir = createTestDir()
    const pidPath = join(dir, 'daemon.pid')
    try {
      publishDaemonPidFile(pidPath, {
        pid: 101,
        startedAtMs: 1_000,
        launchNonce: 'launch-a'
      })

      expect(() =>
        publishDaemonPidFile(pidPath, {
          pid: 202,
          startedAtMs: 2_000,
          launchNonce: 'launch-b'
        })
      ).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('atomically replaces stale ownership with the authenticated endpoint identity', () => {
    const dir = createTestDir()
    const pidPath = join(dir, 'daemon.pid')
    const endpointIdentity = {
      pid: 202,
      startedAtMs: 2_000,
      launchNonce: 'launch-b'
    }
    try {
      writeFileSync(pidPath, '{"pid":101,"launchNonce":"launch-a"}')

      expect(replaceDaemonPidFile(pidPath, endpointIdentity)).toBe(true)
      expect(JSON.parse(readFileSync(pidPath, 'utf8'))).toEqual(endpointIdentity)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reports failure and preserves the record when the rename claim fails for any reason but absence', () => {
    // A read-only parent denies the rename with EACCES, standing in for the Windows
    // AV/indexer lock that fails the claim on a record which is merely open.
    if (process.platform === 'win32' || process.getuid?.() === 0) {
      return
    }
    const dir = createTestDir()
    const pidPath = join(dir, 'daemon.pid')
    const existingRecord = '{"pid":101,"launchNonce":"launch-a"}'
    writeFileSync(pidPath, existingRecord)
    try {
      chmodSync(dir, 0o500)

      expect(
        replaceDaemonPidFile(pidPath, { pid: 202, startedAtMs: 2_000, launchNonce: 'launch-b' })
      ).toBe(false)
      expect(readFileSync(pidPath, 'utf8')).toBe(existingRecord)
    } finally {
      chmodSync(dir, 0o700)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

function listenOnSocketPath(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function closeSocketServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve()
      return
    }
    server.close(() => resolve())
  })
}

function connectsToSocketPath(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath })
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, 500)
    socket.on('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

describe('daemon socket publication', () => {
  it('keeps the bind name shorter than the canonical endpoint', () => {
    // sockaddr_un caps the path, so the private bind name must never extend it.
    const canonicalPath = getDaemonSocketPath('/tmp/orca-daemon-runtime')

    expect(getDaemonSocketBindPath(canonicalPath).length).toBeLessThan(canonicalPath.length)
  })

  it.skipIf(process.platform === 'win32')(
    'keeps a live incumbent reachable when a second listener publishes',
    async () => {
      const dir = createTestDir()
      const canonicalPath = getDaemonSocketPath(dir)
      const incumbent = createServer((socket) => socket.end())
      const newcomer = createServer((socket) => socket.end())
      try {
        const incumbentBind = getDaemonSocketBindPath(canonicalPath)
        await listenOnSocketPath(incumbent, incumbentBind)
        const incumbentOutcome = await publishDaemonEndpoint(
          incumbentBind,
          canonicalPath,
          probeSocketConnect
        )
        expect(incumbentOutcome.status).toBe('published')
        const incumbentIdentity = readDaemonSocketIdentity(canonicalPath)

        const newcomerBind = getDaemonSocketBindPath(canonicalPath)
        await listenOnSocketPath(newcomer, newcomerBind)
        await expect(
          publishDaemonEndpoint(newcomerBind, canonicalPath, probeSocketConnect)
        ).resolves.toEqual({ status: 'occupied' })

        expect(readDaemonSocketIdentity(canonicalPath)).toEqual(incumbentIdentity)
        await expect(connectsToSocketPath(canonicalPath)).resolves.toBe(true)
      } finally {
        await closeSocketServer(incumbent)
        await closeSocketServer(newcomer)
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'leaves an unclassifiable incumbent untouched',
    async () => {
      const dir = createTestDir()
      const canonicalPath = getDaemonSocketPath(dir)
      const newcomer = createServer((socket) => socket.end())
      try {
        writeFileSync(canonicalPath, 'incumbent')
        const newcomerBind = getDaemonSocketBindPath(canonicalPath)
        await listenOnSocketPath(newcomer, newcomerBind)

        await expect(
          publishDaemonEndpoint(newcomerBind, canonicalPath, async () => 'unknown')
        ).resolves.toEqual({ status: 'inconclusive' })
        expect(readFileSync(canonicalPath, 'utf8')).toBe('incumbent')
      } finally {
        await closeSocketServer(newcomer)
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'replaces a dead incumbent with a reachable listener',
    async () => {
      const dir = createTestDir()
      const canonicalPath = getDaemonSocketPath(dir)
      const incumbent = createServer((socket) => socket.end())
      const replacement = createServer((socket) => socket.end())
      try {
        const incumbentBind = getDaemonSocketBindPath(canonicalPath)
        await listenOnSocketPath(incumbent, incumbentBind)
        await publishDaemonEndpoint(incumbentBind, canonicalPath, probeSocketConnect)
        await closeSocketServer(incumbent)
        await expect(connectsToSocketPath(canonicalPath)).resolves.toBe(false)

        const replacementBind = getDaemonSocketBindPath(canonicalPath)
        await listenOnSocketPath(replacement, replacementBind)
        const outcome = await publishDaemonEndpoint(
          replacementBind,
          canonicalPath,
          probeSocketConnect
        )

        expect(outcome.status).toBe('published')
        await expect(connectsToSocketPath(canonicalPath)).resolves.toBe(true)
      } finally {
        await closeSocketServer(incumbent)
        await closeSocketServer(replacement)
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})

describe('sweepAbandonedDaemonClaims', () => {
  const claimNames = [
    `daemon-v${PROTOCOL_VERSION}.pid.cleanup-123-${randomUUID()}`,
    `daemon-v${PROTOCOL_VERSION}.pid.replace-123-${randomUUID()}`,
    // Why generated rather than handwritten: a literal proves the regexp matches the literal.
    // Only a real bind name proves the sweep still recognises what publishing actually creates.
    basename(getDaemonSocketBindPath(join('/tmp', 'daemon.sock')))
  ]
  const preservedNames = [`daemon-v${PROTOCOL_VERSION}.pid`, `daemon-v${PROTOCOL_VERSION}.token`]

  function seedClaimDir(): string {
    const dir = createTestDir()
    for (const name of [...claimNames, ...preservedNames]) {
      writeFileSync(join(dir, name), 'x')
    }
    return dir
  }

  it('removes aged claim and bind scratch names without touching daemon artifacts', async () => {
    const dir = seedClaimDir()
    try {
      await expect(
        sweepAbandonedDaemonClaims(dir, undefined, Date.now() + 24 * 60 * 60 * 1000)
      ).resolves.toBe(claimNames.length)

      for (const name of claimNames) {
        expect(existsSync(join(dir, name))).toBe(false)
      }
      for (const name of preservedNames) {
        expect(existsSync(join(dir, name))).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves freshly written claims alone so an in-flight claim is never stolen', async () => {
    const dir = seedClaimDir()
    try {
      await expect(sweepAbandonedDaemonClaims(dir)).resolves.toBe(0)

      for (const name of [...claimNames, ...preservedNames]) {
        expect(existsSync(join(dir, name))).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'keeps an aged bind name that something is still listening on',
    async () => {
      // Why: a bind name is the only name its daemon has between listen and publish, and age
      // does not prove death — a process stopped by a debugger or a host suspend is still
      // serving. Removing it would destroy a live listener's sole reachable name.
      const dir = createTestDir()
      const bindPath = join(dir, '.b00feed1234')
      const server = createServer((socket) => socket.end())
      try {
        await listenOnSocketPath(server, bindPath)

        await expect(
          sweepAbandonedDaemonClaims(dir, undefined, Date.now() + 24 * 60 * 60 * 1000)
        ).resolves.toBe(0)
        expect(existsSync(bindPath)).toBe(true)
        await expect(connectsToSocketPath(bindPath)).resolves.toBe(true)

        // Once nothing answers it, the same aged name is debris and is reclaimed.
        await closeSocketServer(server)
        writeFileSync(bindPath, '')
        await expect(
          sweepAbandonedDaemonClaims(dir, undefined, Date.now() + 24 * 60 * 60 * 1000)
        ).resolves.toBe(1)
        expect(existsSync(bindPath)).toBe(false)
      } finally {
        await closeSocketServer(server)
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'keeps an aged bind name whose liveness could not be classified',
    async () => {
      // Why: an unclassifiable probe — a timeout on a loaded host, an EPERM — proves nothing,
      // and this name is the only one its daemon has. Removing on anything short of proof of
      // death is the third-party reclaim mistake aimed at the bind name instead.
      const dir = createTestDir()
      const bindPath = join(dir, '.b00feed5678')
      const server = createServer((socket) => socket.end())
      try {
        await listenOnSocketPath(server, bindPath)

        await expect(
          sweepAbandonedDaemonClaims(
            dir,
            undefined,
            Date.now() + 24 * 60 * 60 * 1000,
            async () => 'unknown'
          )
        ).resolves.toBe(0)
        expect(existsSync(bindPath)).toBe(true)
        await expect(connectsToSocketPath(bindPath)).resolves.toBe(true)
      } finally {
        await closeSocketServer(server)
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(process.platform === 'win32')(
    'defers aged bind names past its probe budget instead of probing them all',
    async () => {
      // Why bounded: an entry that never classifies is kept and re-probed on every launch, so an
      // unbounded sweep gets slower each time. Probes are capped and the rest wait for next time.
      const dir = createTestDir()
      const aged = Date.now() + 24 * 60 * 60 * 1000
      const servers: Server[] = []
      try {
        for (let i = 0; i < 20; i++) {
          const server = createServer((socket) => socket.end())
          servers.push(server)
          await listenOnSocketPath(server, join(dir, `.b${i.toString(16).padStart(10, '0')}`))
        }
        let probed = 0
        await sweepAbandonedDaemonClaims(dir, undefined, aged, async () => {
          probed++
          return 'unknown'
        })

        // 20 aged live binds, but only the budget is spent; none are removed on 'unknown'.
        expect(probed).toBe(16)
        expect(readdirSync(dir)).toHaveLength(20)
      } finally {
        for (const server of servers) {
          await closeSocketServer(server)
        }
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )

  it('returns zero when the runtime dir does not exist', async () => {
    await expect(
      sweepAbandonedDaemonClaims(join(tmpdir(), `daemon-sweep-missing-${randomUUID()}`))
    ).resolves.toBe(0)
  })
})
