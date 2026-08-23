import { mkdtempSync, rmSync } from 'node:fs'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DaemonClient } from './client'
import { DaemonServer } from './daemon-server'
import type { SubprocessHandle } from './session-subprocess-handle'

describe('daemon server UTF-8 request framing', () => {
  const directories: string[] = []
  const servers: DaemonServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.shutdown()))
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves a multibyte write split across control-socket chunks', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'daemon-utf8-framing-'))
    directories.push(directory)
    const write = vi.fn()
    let onExit: ((code: number) => void) | undefined
    const subprocess: SubprocessHandle = {
      pid: 55_555,
      getForegroundProcess: () => null,
      write,
      resize: vi.fn(),
      kill: vi.fn(() => onExit?.(0)),
      terminateOwnedTree: () => 'unavailable',
      forceKill: vi.fn(() => onExit?.(137)),
      signal: vi.fn(),
      onData: vi.fn(),
      onExit(callback) {
        onExit = callback
      },
      dispose: vi.fn()
    }
    const socketPath = join(directory, 'daemon.sock')
    const tokenPath = join(directory, 'daemon.token')
    const server = new DaemonServer({ socketPath, tokenPath, spawnSubprocess: () => subprocess })
    servers.push(server)
    await server.start()
    const client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    await client.request('createOrAttach', { sessionId: 'unicode', cols: 80, rows: 24 })

    const controlSocket = (client as unknown as { controlSocket: Socket }).controlSocket
    const encoded = Buffer.from(
      `${JSON.stringify({
        id: 'notify_unicode',
        type: 'write',
        payload: { sessionId: 'unicode', data: 'before 🦀 after' }
      })}\n`
    )
    const crabStart = encoded.indexOf(Buffer.from('🦀'))
    controlSocket.write(encoded.subarray(0, crabStart + 2))
    controlSocket.write(encoded.subarray(crabStart + 2))

    await vi.waitFor(() => expect(write).toHaveBeenCalledWith('before 🦀 after'))
    client.disconnect()
  })
})
