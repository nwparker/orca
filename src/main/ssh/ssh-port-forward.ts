import type { SshConnection } from './ssh-connection'
import { Ssh2PortForwardProvider } from './ssh2-port-forward-provider'
import { SystemSshPortForwardProvider } from './system-ssh-port-forward-provider'
import type { PortForwardEntry } from '../../shared/ssh-types'
import type {
  PortForwardCloseReason,
  SshPortForwardProvider,
  StartedPortForward
} from './ssh-port-forward-provider'
import {
  portForwardClosedDuringStartError,
  PortForwardStartCancelledError,
  type SshPortForwardOperation,
  SshPortForwardOperationSet
} from './ssh-port-forward-operation'

export type { PortForwardEntry }
export type { PortForwardCloseReason }

type SshPortForwardManagerCallbacks = {
  onForwardClosed?: (entry: PortForwardEntry, reason: PortForwardCloseReason) => void
}

export class SshPortForwardManager {
  private forwards = new Map<string, StartedPortForward>()
  private operations = new SshPortForwardOperationSet()
  private connectionTeardowns = new Map<string, Promise<void>>()
  private nextId = 1
  private providers: SshPortForwardProvider[]
  private callbacks: SshPortForwardManagerCallbacks
  private disposed = false

  constructor(
    callbacks: SshPortForwardManagerCallbacks = {},
    providers: SshPortForwardProvider[] = [
      new Ssh2PortForwardProvider(),
      new SystemSshPortForwardProvider()
    ]
  ) {
    this.callbacks = callbacks
    this.providers = providers
  }

  setCallbacks(callbacks: SshPortForwardManagerCallbacks): void {
    this.callbacks = callbacks
  }

  async addForward(
    connectionId: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    label?: string
  ): Promise<PortForwardEntry> {
    const operation = this.operations.begin(connectionId)
    try {
      return await this.addForwardWithId(
        `pf-${this.nextId++}`,
        connectionId,
        conn,
        localPort,
        remoteHost,
        remotePort,
        operation,
        label
      )
    } finally {
      this.operations.finish(operation)
    }
  }

  private async addForwardWithId(
    id: string,
    connectionId: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    operation: SshPortForwardOperation,
    label?: string
  ): Promise<PortForwardEntry> {
    operation.throwIfCancelled(this.disposed || this.connectionTeardowns.has(connectionId))
    const provider = this.providers.find((candidate) => candidate.canHandle(conn))
    if (!provider) {
      throw new Error('SSH connection is not established')
    }

    let starting = true
    const startState: {
      unexpectedClose?: Readonly<{ entry: PortForwardEntry; reason: PortForwardCloseReason }>
    } = {}
    let forward: StartedPortForward | null = null
    try {
      forward = await provider.start(conn, {
        id,
        connectionId,
        localHost: '127.0.0.1',
        localPort,
        remoteHost,
        remotePort,
        label,
        onUnexpectedClose: (entry, reason) => {
          if (starting) {
            startState.unexpectedClose ??= { entry, reason }
            return
          }
          const active = this.forwards.get(id)
          if (active !== forward) {
            return
          }
          this.forwards.delete(id)
          this.callbacks.onForwardClosed?.(entry, reason)
        }
      })
      const unpublishedError =
        operation.cancelled || this.disposed || this.connectionTeardowns.has(connectionId)
          ? new PortForwardStartCancelledError()
          : startState.unexpectedClose
            ? portForwardClosedDuringStartError(startState.unexpectedClose.reason)
            : null
      if (unpublishedError) {
        await operation.runCleanup(() => forward!.close())
        throw unpublishedError
      }
      this.forwards.set(id, forward)
      return forward.entry
    } finally {
      starting = false
    }
  }

  async updateForward(
    id: string,
    conn: SshConnection,
    localPort: number,
    remoteHost: string,
    remotePort: number,
    label?: string
  ): Promise<PortForwardEntry> {
    const existing = this.forwards.get(id)
    if (!existing) {
      throw new Error(`Port forward "${id}" not found`)
    }
    const oldEntry = { ...existing.entry }
    const operation = this.operations.begin(oldEntry.connectionId)

    try {
      operation.throwIfCancelled(
        this.disposed || this.connectionTeardowns.has(oldEntry.connectionId)
      )
      // Why: use the async variant so the OS fully releases the port before
      // we try to rebind. Without this, same-port edits (e.g. label change)
      // fail with EADDRINUSE because server.close() is async.
      await operation.runCleanup(() => this.removeForwardAsync(id))

      try {
        return await this.addForwardWithId(
          oldEntry.id,
          oldEntry.connectionId,
          conn,
          localPort,
          remoteHost,
          remotePort,
          operation,
          label
        )
      } catch (err) {
        if (err instanceof PortForwardStartCancelledError || operation.cancelled) {
          throw err
        }
        // Why: preserve the ID so renderer references survive a failed edit.
        try {
          await this.addForwardWithId(
            oldEntry.id,
            oldEntry.connectionId,
            conn,
            oldEntry.localPort,
            oldEntry.remoteHost,
            oldEntry.remotePort,
            operation,
            oldEntry.label
          )
        } catch {
          // best-effort rollback
        }
        throw err
      }
    } finally {
      this.operations.finish(operation)
    }
  }

  removeForward(id: string): PortForwardEntry | null {
    const forward = this.forwards.get(id)
    if (!forward) {
      return null
    }
    this.forwards.delete(id)
    forward.dispose()
    return forward.entry
  }

  async removeForwardAndWait(id: string): Promise<PortForwardEntry | null> {
    const forward = this.forwards.get(id)
    if (!forward) {
      return null
    }
    const operation = this.operations.begin(forward.entry.connectionId)
    try {
      return await operation.runCleanup(() => this.removeForwardAsync(id))
    } finally {
      this.operations.finish(operation)
    }
  }

  // Why: server.close()/process exit are async — callers that need to rebind
  // the same port (update/reconnect) must wait until the owner fully releases it.
  private removeForwardAsync(id: string): Promise<PortForwardEntry | null> {
    const forward = this.forwards.get(id)
    if (!forward) {
      return Promise.resolve(null)
    }
    this.forwards.delete(id)
    return forward.close().then(() => forward.entry)
  }

  listForwards(connectionId?: string): PortForwardEntry[] {
    const entries: PortForwardEntry[] = []
    for (const { entry } of this.forwards.values()) {
      if (!connectionId || entry.connectionId === connectionId) {
        entries.push(entry)
      }
    }
    return entries
  }

  removeAllForwards(connectionId: string): Promise<void> {
    const existing = this.connectionTeardowns.get(connectionId)
    if (existing) {
      return existing
    }
    let pendingOperations: SshPortForwardOperation[] = []
    let tracked!: Promise<void>
    tracked = Promise.resolve()
      .then(() => this.removeAllForwardsNow(connectionId, pendingOperations))
      .finally(() => {
        if (this.connectionTeardowns.get(connectionId) === tracked) {
          this.connectionTeardowns.delete(connectionId)
        }
      })
    this.connectionTeardowns.set(connectionId, tracked)
    pendingOperations = this.operations.cancelForConnection(connectionId)
    return tracked
  }

  private async removeAllForwardsNow(
    connectionId: string,
    pendingOperations: SshPortForwardOperation[]
  ): Promise<void> {
    const operations = this.operations.cancelForConnection(connectionId, pendingOperations)
    const toRemove = [...this.forwards.entries()]
      .filter(([, { entry }]) => entry.connectionId === connectionId)
      .map(([id]) => id)
    const results = await Promise.allSettled([
      ...toRemove.map((id) => this.removeForwardAsync(id)),
      ...operations.map((operation) => operation.settled)
    ])
    const failedCleanup = operations.find((operation) => operation.cleanupFailed)
    if (failedCleanup) {
      throw failedCleanup.cleanupError
    }
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    )
    if (rejected) {
      throw rejected.reason
    }
  }

  dispose(): void {
    this.disposed = true
    this.operations.cancelAll()
    const ids = [...this.forwards.keys()]
    for (const id of ids) {
      this.removeForward(id)
    }
  }
}
