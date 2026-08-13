import { describe, expect, it, vi } from 'vitest'
import type { SshConnection } from './ssh-connection'
import type {
  PortForwardStartOptions,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'
import { SshPortForwardManager } from './ssh-port-forward'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function startedForward(
  options: PortForwardStartOptions,
  overrides: Partial<Pick<StartedPortForward, 'close' | 'dispose'>> = {}
): StartedPortForward {
  return {
    entry: {
      id: options.id,
      connectionId: options.connectionId,
      localPort: options.localPort,
      remoteHost: options.remoteHost,
      remotePort: options.remotePort,
      label: options.label
    },
    close: overrides.close ?? vi.fn().mockResolvedValue(undefined),
    dispose: overrides.dispose ?? vi.fn()
  }
}

function createManager(
  start: SshPortForwardProvider['start'],
  onForwardClosed = vi.fn()
): { manager: SshPortForwardManager; onForwardClosed: ReturnType<typeof vi.fn> } {
  const provider: SshPortForwardProvider = {
    canHandle: () => true,
    start
  }
  return {
    manager: new SshPortForwardManager({ onForwardClosed }, [provider]),
    onForwardClosed
  }
}

const connection = {} as SshConnection

describe('SshPortForwardManager lifecycle ordering', () => {
  it('fences publication and waits for a cancelled pending start to close', async () => {
    const startGate = deferred<StartedPortForward>()
    const closeGate = deferred<void>()
    const close = vi.fn(() => closeGate.promise)
    let firstStart = true
    let firstOptions!: PortForwardStartOptions
    const start = vi.fn(async (_conn: SshConnection, options: PortForwardStartOptions) => {
      if (firstStart) {
        firstStart = false
        firstOptions = options
        return startGate.promise
      }
      return startedForward(options)
    })
    const { manager } = createManager(start)
    const adding = manager
      .addForward('conn-1', connection, 3000, 'localhost', 8080)
      .catch((error: unknown) => error)

    expect(start).toHaveBeenCalledOnce()
    let removalSettled = false
    const removal = manager.removeAllForwards('conn-1').then(() => {
      removalSettled = true
    })
    const blocked = manager
      .addForward('conn-1', connection, 3001, 'localhost', 8081)
      .catch((error: unknown) => error)

    await expect(blocked).resolves.toMatchObject({ name: 'AbortError' })
    expect(start).toHaveBeenCalledOnce()

    startGate.resolve(startedForward(firstOptions, { close }))
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(manager.listForwards()).toEqual([])
    expect(removalSettled).toBe(false)

    closeGate.resolve()
    await removal
    await expect(adding).resolves.toMatchObject({ name: 'AbortError' })

    await expect(
      manager.addForward('conn-1', connection, 3002, 'localhost', 8082)
    ).resolves.toMatchObject({ connectionId: 'conn-1', localPort: 3002 })
    expect(start).toHaveBeenCalledTimes(2)
  })

  it('closes a pending start that resolves after manager disposal', async () => {
    const startGate = deferred<StartedPortForward>()
    let options!: PortForwardStartOptions
    const close = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn(async (_conn: SshConnection, value: PortForwardStartOptions) => {
      options = value
      return startGate.promise
    })
    const { manager } = createManager(start)
    const adding = manager
      .addForward('conn-1', connection, 3000, 'localhost', 8080)
      .catch((error: unknown) => error)

    manager.dispose()
    startGate.resolve(startedForward(options, { close }))

    await expect(adding).resolves.toMatchObject({ name: 'AbortError' })
    expect(close).toHaveBeenCalledOnce()
    expect(manager.listForwards()).toEqual([])
    await expect(
      manager.addForward('conn-1', connection, 3001, 'localhost', 8081)
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(start).toHaveBeenCalledOnce()
  })

  it('keeps teardown fenced across an in-flight update close', async () => {
    const closeGate = deferred<void>()
    const close = vi.fn(() => closeGate.promise)
    let firstStart = true
    const start = vi.fn(async (_conn: SshConnection, options: PortForwardStartOptions) => {
      if (firstStart) {
        firstStart = false
        return startedForward(options, { close })
      }
      return startedForward(options)
    })
    const { manager } = createManager(start)
    const entry = await manager.addForward('conn-1', connection, 3000, 'localhost', 8080)
    const updating = manager
      .updateForward(entry.id, connection, 3001, 'localhost', 8081)
      .catch((error: unknown) => error)

    let teardownSettled = false
    const teardown = manager.removeAllForwards('conn-1').then(() => {
      teardownSettled = true
    })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(teardownSettled).toBe(false)

    closeGate.resolve()
    await expect(updating).resolves.toMatchObject({ name: 'AbortError' })
    await teardown
    expect(start).toHaveBeenCalledOnce()
    expect(manager.listForwards()).toEqual([])
  })

  it('does not publish a resolved start after teardown installs its fence', async () => {
    const startGate = deferred<StartedPortForward>()
    const close = vi.fn().mockResolvedValue(undefined)
    let options!: PortForwardStartOptions
    const start = vi.fn((_conn: SshConnection, value: PortForwardStartOptions) => {
      options = value
      return startGate.promise
    })
    const { manager } = createManager(start)
    const adding = manager
      .addForward('conn-1', connection, 3000, 'localhost', 8080)
      .catch((error: unknown) => error)

    startGate.resolve(startedForward(options, { close }))
    const teardown = manager.removeAllForwards('conn-1')

    await expect(adding).resolves.toMatchObject({ name: 'AbortError' })
    await teardown
    expect(close).toHaveBeenCalledOnce()
    expect(manager.listForwards()).toEqual([])
  })

  it('rejects a forward that reports closure before startup resolves', async () => {
    const close = vi.fn().mockResolvedValue(undefined)
    const start = vi.fn(async (_conn: SshConnection, options: PortForwardStartOptions) => {
      const forward = startedForward(options, { close })
      options.onUnexpectedClose?.(forward.entry, {
        kind: 'unexpected-exit',
        detail: 'startup process exited'
      })
      return forward
    })
    const { manager, onForwardClosed } = createManager(start)

    await expect(manager.addForward('conn-1', connection, 3000, 'localhost', 8080)).rejects.toThrow(
      'Port forward closed during startup: startup process exited'
    )
    expect(close).toHaveBeenCalledOnce()
    expect(onForwardClosed).not.toHaveBeenCalled()
    expect(manager.listForwards()).toEqual([])
  })

  it('removes active identity before synchronous intentional disposal', async () => {
    let options!: PortForwardStartOptions
    let forward!: StartedPortForward
    const dispose = vi.fn(() => {
      options.onUnexpectedClose?.(forward.entry, {
        kind: 'unexpected-exit',
        detail: 'disposed'
      })
    })
    const start = vi.fn(async (_conn: SshConnection, value: PortForwardStartOptions) => {
      options = value
      forward = startedForward(options, { dispose })
      return forward
    })
    const { manager, onForwardClosed } = createManager(start)
    const entry = await manager.addForward('conn-1', connection, 3000, 'localhost', 8080)

    expect(manager.removeForward(entry.id)).toEqual(entry)
    expect(dispose).toHaveBeenCalledOnce()
    expect(onForwardClosed).not.toHaveBeenCalled()
    expect(manager.listForwards()).toEqual([])
  })
})
