const CHILD_TERMINATION_GRACE_MS = 5_000
const CHILD_FORCE_EXIT_WAIT_MS = 1_000

type DaemonChildStream = {
  on(event: string, listener: (chunk: Buffer) => void): unknown
  off(event: string, listener: (chunk: Buffer) => void): unknown
  destroy(): void
}

export type DaemonChildProcess = {
  pid?: number
  exitCode: number | null
  signalCode: NodeJS.Signals | null
  connected: boolean
  stderr: DaemonChildStream | null
  on(event: string, listener: (value: never) => void): unknown
  once(event: string, listener: () => void): unknown
  off(event: string, listener: (...args: never[]) => void): unknown
  disconnect(): void
  unref(): void
}

export type DaemonFork = (
  entryPath: string,
  args: string[],
  options: Record<string, unknown>
) => DaemonChildProcess

export function isValidDaemonChildPid(pid: number | undefined): pid is number {
  return Number.isSafeInteger(pid) && (pid as number) > 0
}

export async function terminateLaunchedDaemonChild(child: DaemonChildProcess): Promise<void> {
  try {
    if (
      (child.exitCode !== null && child.exitCode !== undefined) ||
      (child.signalCode !== null && child.signalCode !== undefined)
    ) {
      return
    }
    await waitForChildTermination(child)
  } finally {
    if (child.connected) {
      child.disconnect()
    }
    child.unref()
  }
}

function waitForChildTermination(child: DaemonChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (error?: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(graceTimer)
      if (forceTimer) {
        clearTimeout(forceTimer)
      }
      child.off('exit', onExit)
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const onExit = (): void => finish()
    child.on('exit', onExit)
    const graceTimer = setTimeout(() => {
      if (!signalChild(child, 'SIGKILL', finish) || settled) {
        return
      }
      forceTimer = setTimeout(
        () => finish(new Error('Daemon did not exit after SIGKILL')),
        CHILD_FORCE_EXIT_WAIT_MS
      )
    }, CHILD_TERMINATION_GRACE_MS)
    signalChild(child, 'SIGTERM', finish)
  })
}

function signalChild(
  child: DaemonChildProcess,
  signal: NodeJS.Signals,
  finish: (error?: unknown) => void
): boolean {
  if (!isValidDaemonChildPid(child.pid)) {
    finish()
    return false
  }
  try {
    process.kill(child.pid, signal)
    return true
  } catch (error) {
    finish(isNoSuchProcessError(error) ? undefined : error)
    return false
  }
}

function isNoSuchProcessError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
}
