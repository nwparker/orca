import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath, publishDaemonPidFile } from './daemon-spawner'
import type { SubprocessHandle } from './session'

function createMockSubprocess(): SubprocessHandle {
  return {
    pid: 55555,
    getForegroundProcess: () => null,
    write() {},
    resize() {},
    kill() {},
    forceKill() {},
    signal() {},
    onData() {},
    onExit() {},
    dispose() {}
  }
}

describe('daemon endpoint ownership publication', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-endpoint-ownership-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(async () => {
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('does not publish an adoptable endpoint before durable ownership succeeds', async () => {
    writeFileSync(tokenPath, 'previous-token')
    const publishEndpointOwnership = vi.fn(() => {
      expect(readFileSync(tokenPath, 'utf8')).toBe('previous-token')
      throw Object.assign(new Error('PID record already owned'), { code: 'EEXIST' })
    })
    server = new DaemonServer({
      socketPath,
      tokenPath,
      publishEndpointOwnership,
      spawnSubprocess: () => createMockSubprocess()
    })

    await expect(server.start()).rejects.toThrow('PID record already owned')

    expect(publishEndpointOwnership).toHaveBeenCalledOnce()
    expect(readFileSync(tokenPath, 'utf8')).toBe('previous-token')
    if (process.platform !== 'win32') {
      expect(existsSync(socketPath)).toBe(false)
    }
  })

  it('rolls back exact PID ownership when token publication fails', async () => {
    const pidPath = join(dir, 'daemon.pid')
    const launchNonce = 'failed-launch'
    mkdirSync(tokenPath)
    server = new DaemonServer({
      socketPath,
      tokenPath,
      pidPath,
      launchNonce,
      publishEndpointOwnership: () =>
        publishDaemonPidFile(pidPath, {
          pid: process.pid,
          startedAtMs: 1_000,
          launchNonce
        }),
      spawnSubprocess: () => createMockSubprocess()
    })

    await expect(server.start()).rejects.toMatchObject({ code: 'EISDIR' })

    expect(existsSync(pidPath)).toBe(false)
    expect(existsSync(tokenPath)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'refuses a second listener when a live daemon socket path was removed',
    async () => {
      const pidPath = join(dir, 'daemon.pid')
      server = new DaemonServer({
        socketPath,
        tokenPath,
        pidPath,
        launchNonce: 'first-launch',
        publishEndpointOwnership: () =>
          publishDaemonPidFile(pidPath, {
            pid: process.pid,
            startedAtMs: 1_000,
            launchNonce: 'first-launch'
          }),
        spawnSubprocess: () => createMockSubprocess()
      })
      await server.start()
      const firstToken = readFileSync(tokenPath, 'utf8')
      unlinkSync(socketPath)

      const duplicate = new DaemonServer({
        socketPath,
        tokenPath,
        pidPath,
        launchNonce: 'second-launch',
        publishEndpointOwnership: () =>
          publishDaemonPidFile(pidPath, {
            pid: process.pid,
            startedAtMs: 2_000,
            launchNonce: 'second-launch'
          }),
        spawnSubprocess: () => createMockSubprocess()
      })
      try {
        await expect(duplicate.start()).rejects.toMatchObject({ code: 'EEXIST' })
        expect(readFileSync(tokenPath, 'utf8')).toBe(firstToken)
        expect(JSON.parse(readFileSync(pidPath, 'utf8'))).toMatchObject({
          startedAtMs: 1_000,
          launchNonce: 'first-launch'
        })
      } finally {
        await duplicate.shutdown()
      }
    }
  )
})
