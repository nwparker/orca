import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { linkSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:net'
import { DaemonServer } from './daemon-server'
import { DaemonClient } from './client'
import { getDaemonSocketPath } from './daemon-spawner'
import type { SubprocessHandle } from './session'
import { waitForEndpointUnreachable } from './daemon-endpoint-reachability-test-harness'

function createMockSubprocess(): SubprocessHandle {
  return {
    pid: 44444,
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

describe('daemon server error handling', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let server: DaemonServer
  let client: DaemonClient | null = null

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-server-errors-'))
    socketPath = getDaemonSocketPath(dir)
    tokenPath = join(dir, 'test.token')
  })

  afterEach(async () => {
    client?.disconnect()
    client = null
    await server?.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps serving after an operational server error instead of dying', async () => {
    // Why: an unhandled 'error' on a net.Server is an uncaught exception. Detaching the startup
    // listener once start() settled left a daemon hosting every terminal on the machine one
    // failed accept away from termination.
    server = new DaemonServer({
      socketPath,
      tokenPath,
      spawnSubprocess: () => createMockSubprocess()
    })
    await server.start()
    const daemon = server as unknown as { server: Server | null }

    expect(daemon.server?.listenerCount('error')).toBe(1)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => daemon.server?.emit('error', new Error('EMFILE: accept failed'))).not.toThrow()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }

    client = new DaemonClient({ socketPath, tokenPath })
    await client.ensureConnected()
    expect(client.isConnected()).toBe(true)
  })

  it.skipIf(process.platform === 'win32')(
    'stands down instead of serving when the server errors while publication is in flight',
    async () => {
      // Why: publishing awaits a liveness probe, so a server error can land mid-flight and the
      // rejection alone cannot stop it. Going on to serve would leave a live published daemon
      // behind a caller told startup failed — and a caller that responds by launching a
      // replacement recreates the split brain.
      // A dead entry on the canonical name forces publish down the probe-then-rename path, so
      // the error below lands inside the async window rather than before it.
      const stale = createServer()
      const stalePath = join(dir, '.bstale00001')
      await new Promise<void>((resolve) => stale.listen(stalePath, resolve))
      linkSync(stalePath, socketPath)
      await new Promise<void>((resolve) => stale.close(() => resolve()))

      server = new DaemonServer({
        socketPath,
        tokenPath,
        spawnSubprocess: () => createMockSubprocess()
      })
      const started = server.start()
      const daemon = server as unknown as { server: Server | null }
      await vi.waitFor(() => expect(daemon.server?.listening).toBe(true))
      daemon.server?.emit('error', new Error('injected accept failure'))

      await expect(started).rejects.toThrow('injected accept failure')
      // Why wait: start() rejects the moment the error lands, while publication is still in
      // flight. Reporting failure must end with the daemon actually not serving.
      await vi.waitFor(() => expect(daemon.server).toBeNull())
      await expect(waitForEndpointUnreachable(socketPath)).resolves.toBe(true)
    }
  )
})
