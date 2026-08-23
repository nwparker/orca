import type * as pty from 'node-pty'
import { resolveProcessExitCause, type TerminalExitCause } from '../../shared/terminal-exit-cause'

const PENDING_PRE_LISTENER_DATA_MAX_CHARS = 512 * 1024

export type DaemonPtyEventBuffer = {
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number, cause?: TerminalExitCause) => void): void
  dispose(): void
}

export function createDaemonPtyEventBuffer(args: {
  proc: pty.IPty
  reportsChildExitStatus: boolean
  noteOutput(data: string): void
}): DaemonPtyEventBuffer {
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number, cause?: TerminalExitCause) => void) | null = null
  let pendingData: string[] = []
  let pendingDataChars = 0
  let pendingExitCode: number | null = null
  let pendingExitCause: TerminalExitCause | null = null

  const bufferData = (data: string): void => {
    pendingData.push(data)
    pendingDataChars += data.length
    while (pendingDataChars > PENDING_PRE_LISTENER_DATA_MAX_CHARS) {
      const removed = pendingData.shift()
      if (removed === undefined) {
        pendingDataChars = 0
        return
      }
      pendingDataChars -= removed.length
    }
  }
  const flushData = (): void => {
    if (!onDataCb || pendingData.length === 0) {
      return
    }
    const pending = pendingData
    pendingData = []
    pendingDataChars = 0
    for (const data of pending) {
      onDataCb(data)
    }
  }

  args.proc.onData((data) => {
    args.noteOutput(data)
    if (onDataCb) {
      onDataCb(data)
    } else {
      bufferData(data)
    }
  })
  args.proc.onExit(({ exitCode, signal }) => {
    const cause = resolveProcessExitCause({
      exitCode,
      signal,
      hostReportsChildExitStatus: args.reportsChildExitStatus
    })
    if (onExitCb) {
      flushData()
      onExitCb(exitCode, cause)
    } else {
      pendingExitCode = exitCode
      pendingExitCause = cause
    }
  })

  return {
    onData(cb) {
      onDataCb = cb
      flushData()
    },
    onExit(cb) {
      onExitCb = cb
      if (pendingExitCode === null) {
        return
      }
      const code = pendingExitCode
      const cause = pendingExitCause ?? resolveProcessExitCause({ exitCode: code })
      pendingExitCode = null
      pendingExitCause = null
      flushData()
      cb(code, cause)
    },
    dispose() {
      onDataCb = null
      onExitCb = null
      pendingData = []
      pendingDataChars = 0
      pendingExitCode = null
      pendingExitCause = null
    }
  }
}
