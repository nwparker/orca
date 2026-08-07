import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  reclaimDeadDaemonSocketPath,
  sweepAbandonedDaemonClaims
} from './daemon-endpoint-ownership'

describe.skipIf(process.platform === 'win32')('daemon endpoint claim recovery', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      chmodSync(dir, 0o700)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function createDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'daemon-endpoint-recovery-'))
    dirs.push(dir)
    return dir
  }

  it('retains and later republishes a claim when canonical restoration fails', async () => {
    const dir = createDir()
    const socketPath = join(dir, 'daemon.sock')
    const server = createServer()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })

    try {
      const outcome = await reclaimDeadDaemonSocketPath(socketPath, async () => {
        chmodSync(dir, 0o500)
        return 'alive'
      })

      expect(outcome).toBe('restoration-failed')
      expect(existsSync(socketPath)).toBe(false)
      const claimPath = join(
        dir,
        readdirSync(dir).find((entry) => entry.startsWith('.c')) as string
      )
      expect(existsSync(claimPath)).toBe(true)
      expect(sweepAbandonedDaemonClaims(dir, 0, Date.now() + 1_000, socketPath)).toBe(0)
      expect(existsSync(claimPath)).toBe(true)

      chmodSync(dir, 0o700)
      expect(sweepAbandonedDaemonClaims(dir, 0, Date.now() + 1_000, socketPath)).toBe(1)
      expect(existsSync(socketPath)).toBe(true)
      expect(existsSync(claimPath)).toBe(false)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('restores a claimed endpoint when its liveness probe rejects', async () => {
    const dir = createDir()
    const socketPath = join(dir, 'daemon.sock')
    writeFileSync(socketPath, 'endpoint')

    await expect(
      reclaimDeadDaemonSocketPath(socketPath, async () => {
        throw new Error('probe construction failed')
      })
    ).resolves.toBe('inconclusive')

    expect(existsSync(socketPath)).toBe(true)
    expect(readdirSync(dir).some((entry) => entry.startsWith('.c'))).toBe(false)
  })
})
