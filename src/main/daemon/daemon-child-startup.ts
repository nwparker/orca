import { app } from 'electron'
import {
  isValidDaemonChildPid,
  terminateLaunchedDaemonChild,
  type DaemonChildProcess,
  type DaemonFork
} from './daemon-child-process'
import { DAEMON_EXIT_ENDPOINT_OCCUPIED } from './daemon-endpoint-ownership'
import { materializeRelocatedDaemonHost } from './daemon-host-relocation'
import type { DaemonEndpointIdentity } from './daemon-hello-protocol'
import { parseDaemonReadyIdentity } from './daemon-ready-identity'
import { unlinkOwnedDaemonPidFile, type DaemonProcessHandle } from './daemon-spawner'
import { getDaemonLogArgs } from './daemon-runtime-paths'

const STARTUP_STDERR_MAX_BYTES = 8_192

export class DaemonEndpointOccupiedError extends Error {}

export type LaunchedDaemonChild = {
  handle: DaemonProcessHandle
  identity: DaemonEndpointIdentity
  removeOwnedPidRecord(): void
  watchPidRecordUntilExit(): void
}

type LaunchDaemonChildOptions = {
  forkDaemon: DaemonFork
  entryPath: string
  socketPath: string
  tokenPath: string
  pidPath: string
  launchNonce: string
  macosLoginSessionWatch: boolean
}

export async function launchDaemonChild(
  options: LaunchDaemonChildOptions
): Promise<LaunchedDaemonChild> {
  const { child, releaseStderr, stderrTail } = forkDetachedDaemon(options)
  let launchedIdentity: DaemonEndpointIdentity | null = null
  let endpointUnavailableReason: string | null = null

  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const cleanupListeners = (): void => {
      if (timer) {
        clearTimeout(timer)
      }
      child.off('message', onMessage)
      child.off('error', onError)
      child.off('exit', onExit)
    }
    const fail = async (error: Error): Promise<void> => {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      const captured = stderrTail().trim()
      if (captured) {
        console.warn(`[daemon] startup failed; captured stderr tail:\n${captured}`)
      }
      releaseStderr()
      const startupError = captured
        ? new Error(`${error.message}\nDaemon stderr (tail):\n${captured}`)
        : error
      try {
        await terminateLaunchedDaemonChild(child)
      } catch (cleanupError) {
        reject(
          new AggregateError(
            [startupError, cleanupError],
            'Daemon startup and child cleanup both failed'
          )
        )
        return
      }
      removeOwnedPidRecord(child, options.pidPath, options.launchNonce)
      reject(startupError)
    }
    function onMessage(message: unknown): void {
      if (isMessageType(message, 'endpoint-unavailable')) {
        endpointUnavailableReason = readEndpointUnavailableReason(message)
        void fail(new Error(`Daemon could not take the endpoint: ${endpointUnavailableReason}`))
        return
      }
      if (!isMessageType(message, 'ready') || settled) {
        return
      }
      const readyIdentity = parseDaemonReadyIdentity(message)
      if (!isValidDaemonChildPid(child.pid) || !readyIdentity) {
        void fail(new Error('Daemon readiness identity is incomplete'))
        return
      }
      launchedIdentity = { pid: child.pid, ...readyIdentity, launchNonce: options.launchNonce }
      settled = true
      cleanupListeners()
      releaseStderr()
      child.disconnect()
      child.unref()
      resolve()
    }
    const onError = (error: Error): void => void fail(error)
    const onExit = (code: number | null): void => {
      if (code === DAEMON_EXIT_ENDPOINT_OCCUPIED) {
        endpointUnavailableReason = 'occupied'
      }
      void fail(new Error(`Daemon exited during startup with code ${code}`))
    }
    timer = setTimeout(() => void fail(new Error('Daemon startup timed out')), 10_000)
    child.on('message', onMessage)
    child.on('error', onError)
    child.on('exit', onExit)
  }).catch((error) => {
    if (endpointUnavailableReason === 'occupied') {
      throw new DaemonEndpointOccupiedError(error instanceof Error ? error.message : String(error))
    }
    throw error
  })

  if (!launchedIdentity) {
    throw new Error('Daemon readiness identity is incomplete')
  }
  return createLaunchedChild(child, launchedIdentity, options.pidPath, options.launchNonce)
}

function forkDetachedDaemon(options: LaunchDaemonChildOptions): {
  child: DaemonChildProcess
  releaseStderr: () => void
  stderrTail: () => string
} {
  const userDataPath = app.getPath('userData')
  const relocatedHost = materializeRelocatedDaemonHost()
  const child = options.forkDaemon(
    relocatedHost?.entryPath ?? options.entryPath,
    buildDaemonArgs(options),
    {
      cwd: userDataPath,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      ...(relocatedHost ? { execPath: relocatedHost.execPath } : {}),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ORCA_USER_DATA_PATH: userDataPath }
    }
  )
  let startupStderr = ''
  let collecting = true
  const onStderr = (chunk: Buffer): void => {
    if (!collecting) {
      return
    }
    startupStderr += chunk.toString('utf8')
    if (startupStderr.length > STARTUP_STDERR_MAX_BYTES) {
      startupStderr = startupStderr.slice(-STARTUP_STDERR_MAX_BYTES)
    }
  }
  child.stderr?.on('data', onStderr)
  return {
    child,
    releaseStderr: () => {
      collecting = false
      child.stderr?.off('data', onStderr)
      child.stderr?.destroy()
    },
    stderrTail: () => startupStderr
  }
}

function buildDaemonArgs(options: LaunchDaemonChildOptions): string[] {
  return [
    '--socket',
    options.socketPath,
    '--token',
    options.tokenPath,
    '--pid-record',
    options.pidPath,
    '--launch-nonce',
    options.launchNonce,
    '--entry-path',
    options.entryPath,
    '--app-version',
    app.getVersion(),
    '--spawner-exec-path',
    process.execPath,
    ...(options.macosLoginSessionWatch ? ['--login-session-watch'] : []),
    ...getDaemonLogArgs()
  ]
}

function createLaunchedChild(
  child: DaemonChildProcess,
  identity: DaemonEndpointIdentity,
  pidPath: string,
  launchNonce: string
): LaunchedDaemonChild {
  return {
    handle: { shutdown: () => terminateLaunchedDaemonChild(child) },
    identity,
    removeOwnedPidRecord: () => removeOwnedPidRecord(child, pidPath, launchNonce),
    watchPidRecordUntilExit: () => watchPidRecordUntilExit(child, pidPath, launchNonce)
  }
}

function removeOwnedPidRecord(
  child: DaemonChildProcess,
  pidPath: string,
  launchNonce: string
): void {
  if (isValidDaemonChildPid(child.pid)) {
    unlinkOwnedDaemonPidFile(pidPath, child.pid, launchNonce)
  }
}

function watchPidRecordUntilExit(
  child: DaemonChildProcess,
  pidPath: string,
  launchNonce: string
): void {
  let removed = false
  const remove = (): void => {
    if (removed) {
      return
    }
    removed = true
    removeOwnedPidRecord(child, pidPath, launchNonce)
  }
  child.once('exit', remove)
  if (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  ) {
    child.off('exit', remove)
    remove()
  }
}

function isMessageType(
  message: unknown,
  type: string
): message is { type: string; reason?: string } {
  return !!message && typeof message === 'object' && (message as { type?: string }).type === type
}

function readEndpointUnavailableReason(message: object): string {
  return (message as { reason?: string }).reason ?? 'occupied'
}
