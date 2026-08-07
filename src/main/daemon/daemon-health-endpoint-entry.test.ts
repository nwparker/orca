import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { killStaleDaemon } from './daemon-health'

describe.skipIf(process.platform === 'win32')('stale daemon endpoint entry cleanup', () => {
  let dir: string
  let socketPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-endpoint-entry-'))
    socketPath = join(dir, 'daemon.sock')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('reclaims an entry when connect reports ENOTSOCK', async () => {
    writeFileSync(socketPath, 'not a socket')
    vi.spyOn(Socket.prototype, 'connect').mockImplementation(function (this: Socket) {
      process.nextTick(() => {
        this.emit('error', Object.assign(new Error('not a socket'), { code: 'ENOTSOCK' }))
      })
      return this
    })

    await expect(killStaleDaemon(dir, socketPath, join(dir, 'daemon.token'))).resolves.toEqual({
      killed: false,
      liveOwnerSurvived: false
    })
    expect(existsSync(socketPath)).toBe(false)
  })

  it('reclaims a dangling symlink instead of reporting the endpoint missing', async () => {
    symlinkSync(join(dir, 'missing-target'), socketPath)

    await expect(killStaleDaemon(dir, socketPath, join(dir, 'daemon.token'))).resolves.toEqual({
      killed: false,
      liveOwnerSurvived: false
    })
    expect(() => lstatSync(socketPath)).toThrow()
  })
})
