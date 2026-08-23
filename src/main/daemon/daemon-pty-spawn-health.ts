import * as pty from 'node-pty'
import { ensureNodePtySpawnHelperExecutable } from '../providers/local-pty-utils'
import {
  formatDaemonPtySpawnError,
  isExistingDaemonPtyDirectory,
  preflightDaemonUnixPtySpawn,
  resolveDaemonPtyDefaultCwd
} from './daemon-pty-spawn-preflight'

const PTY_SPAWN_HEALTH_TIMEOUT_MS = 4_000
const PTY_SPAWN_HEALTH_RETRY_ATTEMPTS = 2

function runSinglePtySpawnHealthProbe(): Promise<void> {
  const cwd = isExistingDaemonPtyDirectory(process.env.ORCA_USER_DATA_PATH)
    ? process.env.ORCA_USER_DATA_PATH
    : resolveDaemonPtyDefaultCwd()
  let proc: pty.IPty
  try {
    proc = pty.spawn('/bin/sh', ['-c', 'exit 0'], {
      name: 'xterm-256color',
      cols: 2,
      rows: 1,
      cwd,
      env: { ...process.env, TERM: 'xterm-256color' }
    })
  } catch (err) {
    throw formatDaemonPtySpawnError(err, '/bin/sh', cwd)
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let exitDisposable: { dispose(): void } | undefined
    const finish = (error?: Error, opts?: { kill?: boolean }): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      exitDisposable?.dispose()
      if (opts?.kill) {
        try {
          proc.kill()
        } catch {
          // Best-effort cleanup for a short-lived probe.
        }
      }
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    const timer = setTimeout(() => {
      finish(new Error(`PTY spawn health check timed out after ${PTY_SPAWN_HEALTH_TIMEOUT_MS}ms`), {
        kill: true
      })
    }, PTY_SPAWN_HEALTH_TIMEOUT_MS)
    exitDisposable = proc.onExit(({ exitCode }) => {
      finish(
        exitCode === 0
          ? undefined
          : new Error(`PTY spawn health check exited with code ${exitCode}`)
      )
    })
  })
}

export async function checkDaemonPtySpawnHealth(): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  if (process.platform === 'darwin') {
    ensureNodePtySpawnHelperExecutable()
  }
  preflightDaemonUnixPtySpawn()
  let lastError: unknown
  for (let attempt = 1; attempt <= PTY_SPAWN_HEALTH_RETRY_ATTEMPTS; attempt++) {
    try {
      await runSinglePtySpawnHealthProbe()
      return
    } catch (err) {
      lastError = err
      if (attempt < PTY_SPAWN_HEALTH_RETRY_ATTEMPTS) {
        console.warn(
          `[daemon] PTY spawn health probe attempt ${attempt} failed; retrying`,
          err instanceof Error ? err.message : err
        )
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}
