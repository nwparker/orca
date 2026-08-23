import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { Server, Socket } from 'node:net'
import { TerminalHost } from './terminal-host'
import { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import {
  BackgroundTransientFactRelay,
  BACKGROUND_STREAM_DROP_ENABLED
} from './daemon-background-transient-facts'
import { extractHiddenStartupRendererQueryData } from '../../shared/terminal-reply-query-extraction'
import { startDaemonStreamBacklogProbe } from './daemon-stream-backlog-probe'
import type { SubprocessHandle } from './session-subprocess-handle'
import { checkPtySpawnHealth } from './pty-subprocess'
import { createNoopDaemonFileLog, type DaemonFileLog } from './daemon-file-log'
import type { DaemonSocketIdentity } from './daemon-endpoint-ownership'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION, PROTOCOL_VERSION } from './types'
import { TerminalHistorySeedTransferRegistry } from './terminal-history-seed-transfer-registry'

export type DaemonServerConstructionOptions = {
  socketPath: string
  tokenPath: string
  pidPath?: string
  launchNonce?: string
  startedAtMs?: number
  publishEndpointOwnership?: () => void
  entryPath?: string
  appVersion?: string
  spawnerExecPath?: string
  protocolVersion?: number
  onIdleShutdown?: () => void
  onRpcShutdown?: () => void
  initialAdoptionTestConfig?: {
    timeoutMs: number
    clock: {
      setTimeout(callback: () => void, delayMs: number): unknown
      clearTimeout(handle: unknown): void
      now(): number
    }
  }
  ptySpawnHealthCheck?: () => Promise<void>
  preparePtySpawn?: () => Promise<void>
  onPtySessionExit?: (sessionId: string) => void
  onAuthenticatedClientPair?: () => void
  log?: DaemonFileLog
  spawnSubprocess: (opts: {
    sessionId: string
    cols: number
    rows: number
    cwd?: string
    env?: Record<string, string>
    command?: string
    shellOverride?: string
    isCanceled?: () => boolean
  }) => SubprocessHandle | Promise<SubprocessHandle>
}

export type ConnectedDaemonClient = {
  clientId: string
  controlSocket: Socket
  streamSocket: Socket | null
  authenticatedPairEstablished: boolean
}

export type PendingPtySpawnPreparation = {
  canceled: boolean
  readonly controller: AbortController
  cancelTimer?: ReturnType<typeof setTimeout>
  clientId: string
  requestId: string
}

export type PendingShutdownReply = { start: () => void }

export function cancelPtySpawnPreparation(preparation: PendingPtySpawnPreparation): void {
  preparation.canceled = true
  preparation.controller.abort()
}

export abstract class DaemonServerRuntime {
  protected static readonly INITIAL_ADOPTION_TIMEOUT_MS = 2 * 60 * 1000
  protected static readonly SHUTDOWN_REPLY_FLUSH_TIMEOUT_MS = 1_000
  protected static readonly ENDPOINT_OWNERSHIP_POLL_MS = 30 * 1000
  protected static readonly ENDPOINT_OWNERSHIP_LOSS_CONFIRMATIONS = 2
  protected static readonly INTERACTIVE_OUTPUT_WINDOW_MS = 100
  protected static readonly INTERACTIVE_OUTPUT_MAX_CHARS = 1024

  protected server: Server | null = null
  protected token = randomUUID()
  protected host: TerminalHost
  protected socketPath: string
  protected tokenPath: string
  protected pidPath: string | null
  protected launchNonce: string | null
  protected startedAtMs: number | null
  protected publishEndpointOwnership: () => void
  protected entryPath: string | null
  protected appVersion: string | null
  protected spawnerExecPath: string | null
  protected ownedSocketIdentity: DaemonSocketIdentity | null = null
  protected startupFailure: Error | null = null
  protected endpointOwnershipTimer: ReturnType<typeof setInterval> | null = null
  protected endpointOwnershipLossStreak = 0
  protected endpointOwnershipLost = false
  protected protocolVersion: number
  protected onIdleShutdown: () => void
  protected onRpcShutdown: () => void
  protected onAuthenticatedClientPair: () => void
  protected ptySpawnHealthCheck: () => Promise<void>
  protected preparePtySpawn: () => Promise<void>
  protected log: DaemonFileLog
  protected transportSockets = new Set<Socket>()
  protected createOrAttachInFlight = 0
  protected idleShutdownState: 'running' | 'idle-shutdown-pending' | 'shutting-down' = 'running'
  protected initialAdoptionTimer: unknown = null
  protected initialAdoptionDeadlineMs: number | null = null
  protected retirementRequested = false
  protected shutdownPromise: Promise<void> | null = null
  protected ordinaryShutdownServerClose: Promise<void> | null = null
  protected pendingShutdownReplies = new Map<string, PendingShutdownReply>()
  protected initialAdoptionTimeoutMs: number
  protected lifecycleClock: NonNullable<
    DaemonServerConstructionOptions['initialAdoptionTestConfig']
  >['clock']
  protected clients = new Map<string, ConnectedDaemonClient>()
  protected streamClientIdBySessionId = new Map<string, string>()
  protected attachTokenBySessionId = new Map<string, symbol>()
  protected lastInputAtBySessionId = new Map<string, number>()
  protected pendingPtySpawnPreparations = new Map<string, Set<PendingPtySpawnPreparation>>()
  protected historySeedTransfers = new TerminalHistorySeedTransferRegistry()
  protected stopStreamBacklogProbe: () => void = () => {}
  protected transientFactRelay: BackgroundTransientFactRelay
  protected streamDataBatcher: DaemonStreamDataBatcher

  constructor(opts: DaemonServerConstructionOptions) {
    this.socketPath = opts.socketPath
    this.tokenPath = opts.tokenPath
    this.pidPath = opts.pidPath ?? null
    this.protocolVersion = opts.protocolVersion ?? PROTOCOL_VERSION
    this.launchNonce =
      opts.launchNonce ??
      (this.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION ? randomUUID() : null)
    this.startedAtMs =
      opts.startedAtMs ??
      (this.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION
        ? Date.now() - process.uptime() * 1000
        : null)
    this.publishEndpointOwnership = opts.publishEndpointOwnership ?? (() => {})
    this.entryPath = opts.entryPath ?? null
    this.appVersion = opts.appVersion ?? null
    this.spawnerExecPath = opts.spawnerExecPath ?? null
    this.onIdleShutdown = opts.onIdleShutdown ?? (() => {})
    this.onRpcShutdown = opts.onRpcShutdown ?? (() => {})
    this.onAuthenticatedClientPair = opts.onAuthenticatedClientPair ?? (() => {})
    this.initialAdoptionTimeoutMs =
      opts.initialAdoptionTestConfig?.timeoutMs ?? DaemonServerRuntime.INITIAL_ADOPTION_TIMEOUT_MS
    this.lifecycleClock = opts.initialAdoptionTestConfig?.clock ?? {
      setTimeout: (callback, delayMs) => {
        const timer = setTimeout(callback, delayMs)
        timer.unref()
        return timer
      },
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      now: () => Date.now()
    }
    this.log = opts.log ?? createNoopDaemonFileLog()
    this.transientFactRelay = new BackgroundTransientFactRelay((sessionId, fact) => {
      const clientId = this.streamClientIdBySessionId.get(sessionId)
      if (clientId) {
        this.streamDataBatcher.enqueueControlEvent(clientId, sessionId, {
          type: 'event',
          event: 'transientFact',
          sessionId,
          payload: fact
        })
      }
    })
    this.streamDataBatcher = new DaemonStreamDataBatcher((clientId) => this.clients.get(clientId), {
      isSessionDroppable: (sessionId) =>
        BACKGROUND_STREAM_DROP_ENABLED && this.transientFactRelay.isBackgrounded(sessionId),
      salvageDroppedData: (dropped) => {
        if (!dropped.includes('\x1b')) {
          return ''
        }
        const extracted = extractHiddenStartupRendererQueryData(dropped, '')
        return (
          extracted.statelessQueryData + extracted.statefulQueryData + extracted.oscColorQueryData
        )
      }
    })
    this.host = new TerminalHost({
      spawnSubprocess: opts.spawnSubprocess,
      reportReadinessEvent: (event, details) => this.log.log(event, details),
      onSessionReaped: (sessionId) => {
        this.streamClientIdBySessionId.delete(sessionId)
        this.attachTokenBySessionId.delete(sessionId)
        this.lastInputAtBySessionId.delete(sessionId)
        this.transientFactRelay.onSessionExit(sessionId)
        this.streamDataBatcher.refreshSessionDroppability(sessionId)
        opts.onPtySessionExit?.(sessionId)
        this.reevaluateIdleShutdown()
      }
    })
    this.ptySpawnHealthCheck = opts.ptySpawnHealthCheck ?? checkPtySpawnHealth
    this.preparePtySpawn = opts.preparePtySpawn ?? (() => Promise.resolve())
    this.stopStreamBacklogProbe = startDaemonStreamBacklogProbe(() => ({
      clients: Array.from(this.clients.values(), (client) => ({
        clientId: client.clientId,
        socketBufferedBytes: client.streamSocket?.writableLength ?? 0,
        batcherQueuedChars: this.streamDataBatcher.queuedCharsForClient(client.clientId)
      })),
      backgroundedSessionIdSuffixes: this.transientFactRelay.backgroundedSessionIdSuffixes()
    }))
  }

  protected abstract reevaluateIdleShutdown(): void

  protected abstract handleConnection(socket: Socket): void

  protected isInteractiveOutput(sessionId: string, data: string): boolean {
    const lastInputAt = this.lastInputAtBySessionId.get(sessionId)
    return (
      data.length <= DaemonServerRuntime.INTERACTIVE_OUTPUT_MAX_CHARS &&
      lastInputAt !== undefined &&
      performance.now() - lastInputAt <= DaemonServerRuntime.INTERACTIVE_OUTPUT_WINDOW_MS
    )
  }
}
