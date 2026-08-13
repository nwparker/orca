import type { PortForwardCloseReason } from './ssh-port-forward-provider'

export class PortForwardStartCancelledError extends Error {
  constructor() {
    super('Port forward start was cancelled')
    this.name = 'AbortError'
  }
}

export function portForwardClosedDuringStartError(reason: PortForwardCloseReason): Error {
  const detail = reason.kind === 'unexpected-exit' ? reason.detail : undefined
  return new Error(`Port forward closed during startup${detail ? `: ${detail}` : ''}`)
}

export class SshPortForwardOperation {
  cancelled = false
  cleanupFailed = false
  cleanupError?: unknown
  readonly settled: Promise<void>
  private settle!: () => void

  constructor(readonly connectionId: string) {
    this.settled = new Promise<void>((resolve) => {
      this.settle = resolve
    })
  }

  cancel(): void {
    this.cancelled = true
  }

  throwIfCancelled(blocked: boolean): void {
    if (this.cancelled || blocked) {
      throw new PortForwardStartCancelledError()
    }
  }

  recordCleanupFailure(error: unknown): void {
    this.cleanupFailed = true
    this.cleanupError = error
  }

  async runCleanup<T>(cleanup: () => Promise<T>): Promise<T> {
    try {
      return await cleanup()
    } catch (error) {
      this.recordCleanupFailure(error)
      throw error
    }
  }

  finish(): void {
    this.settle()
  }
}

export class SshPortForwardOperationSet {
  private readonly operations = new Set<SshPortForwardOperation>()

  begin(connectionId: string): SshPortForwardOperation {
    const operation = new SshPortForwardOperation(connectionId)
    this.operations.add(operation)
    return operation
  }

  finish(operation: SshPortForwardOperation): void {
    this.operations.delete(operation)
    operation.finish()
  }

  cancelForConnection(
    connectionId: string,
    include: SshPortForwardOperation[] = []
  ): SshPortForwardOperation[] {
    const matching = [
      ...new Set([
        ...include,
        ...[...this.operations].filter((operation) => operation.connectionId === connectionId)
      ])
    ]
    for (const operation of matching) {
      operation.cancel()
    }
    return matching
  }

  cancelAll(): void {
    for (const operation of this.operations) {
      operation.cancel()
    }
  }
}
