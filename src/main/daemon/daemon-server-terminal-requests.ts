import { performance } from 'node:perf_hooks'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import { DaemonServerAdmission } from './daemon-server-admission'
import { SessionNotFoundError, type DaemonRequest } from './types'
import type { ConnectedDaemonClient } from './daemon-server-runtime'

export const UNHANDLED_DAEMON_REQUEST = Symbol('unhandled-daemon-request')

type DaemonControlRequest = Extract<
  DaemonRequest,
  {
    type:
      | 'startHistorySeedTransfer'
      | 'appendHistorySeedTransfer'
      | 'finishHistorySeedTransfer'
      | 'abortHistorySeedTransfer'
      | 'shutdownIfIdle'
      | 'ping'
      | 'systemResolverHealth'
      | 'ptySpawnHealth'
      | 'shutdown'
  }
>

type TerminalDaemonRequest = Exclude<DaemonRequest, DaemonControlRequest>
type TerminalRequestRouteResult = object | null | typeof UNHANDLED_DAEMON_REQUEST

const TERMINAL_DAEMON_REQUEST_TYPES = {
  createOrAttach: true,
  cancelCreateOrAttach: true,
  closeStartupQueryAuthority: true,
  write: true,
  resize: true,
  pausePty: true,
  resumePty: true,
  setSessionBackground: true,
  kill: true,
  signal: true,
  detach: true,
  getCwd: true,
  getForegroundProcess: true,
  inspectProcess: true,
  confirmForegroundProcess: true,
  clearScrollback: true,
  listSessions: true,
  getSnapshot: true,
  getSize: true,
  takePendingOutput: true
} satisfies Record<TerminalDaemonRequest['type'], true>

export function isTerminalDaemonRequest(request: DaemonRequest): request is TerminalDaemonRequest {
  return Object.hasOwn(TERMINAL_DAEMON_REQUEST_TYPES, request.type)
}

export class DaemonServerTerminalRequests extends DaemonServerAdmission {
  protected routeTerminalRequest(
    clientId: string,
    request: DaemonRequest
  ): TerminalRequestRouteResult {
    if (!isTerminalDaemonRequest(request)) {
      return UNHANDLED_DAEMON_REQUEST
    }
    const client = this.clients.get(clientId)
    switch (request.type) {
      case 'createOrAttach':
        return this.createOrAttachSession(clientId, request)
      case 'cancelCreateOrAttach':
        return {
          canceled: this.cancelPendingPtySpawnPreparations(request.payload.sessionId, {
            clientId,
            ...(typeof request.payload.requestId === 'string'
              ? { requestId: request.payload.requestId }
              : {})
          })
        }
      case 'closeStartupQueryAuthority':
        return { appliedSeq: this.host.closeStartupQueryAuthority(request.payload.sessionId) }
      case 'write':
        return this.writeToSession(client, request.payload.sessionId, request.payload.data)
      case 'resize':
        return this.resizeSession(
          client,
          request.payload.sessionId,
          request.payload.cols,
          request.payload.rows
        )
      case 'pausePty':
        this.host.pauseProducer(request.payload.sessionId)
        return {}
      case 'resumePty':
        this.host.resumeProducer(request.payload.sessionId)
        return {}
      case 'setSessionBackground':
        return this.setSessionBackground(
          request.payload.sessionId,
          request.payload.background === true
        )
      case 'kill':
        return this.killSession(clientId, request.payload)
      case 'signal':
        this.host.signal(request.payload.sessionId, request.payload.signal)
        return {}
      case 'detach':
        this.detachSessionForClient(request.payload.sessionId, clientId)
        this.log.log('session-detached', { sessionId: request.payload.sessionId })
        return {}
      case 'getCwd':
        return this.host.getCwd(request.payload.sessionId).then((cwd) => ({ cwd }))
      case 'getForegroundProcess':
        return { foregroundProcess: this.host.getForegroundProcess(request.payload.sessionId) }
      case 'inspectProcess':
        return this.host.inspectProcess(request.payload.sessionId)
      case 'confirmForegroundProcess':
        return this.host
          .confirmForegroundProcess(request.payload.sessionId)
          .then((foregroundProcess) => ({ foregroundProcess }))
      case 'clearScrollback':
        this.host.clearScrollback(request.payload.sessionId)
        return {}
      case 'listSessions':
        return { sessions: this.host.listSessions() }
      case 'getSnapshot':
        return this.getSessionSnapshot(request.payload.sessionId, request.payload.scrollbackRows)
      case 'getSize':
        return { size: this.host.getAppliedSize(request.payload.sessionId) }
      case 'takePendingOutput':
        return this.host.takePendingOutput(
          request.payload.sessionId,
          request.payload.includeSnapshot === true,
          { teardownSnapshot: request.payload.teardownSnapshot === true }
        )
    }
  }

  protected writeToSession(
    client: ConnectedDaemonClient | undefined,
    sessionId: string,
    data: string
  ): Record<string, never> {
    try {
      this.lastInputAtBySessionId.set(sessionId, performance.now())
      this.host.write(sessionId, data)
    } catch (error) {
      this.lastInputAtBySessionId.delete(sessionId)
      if (error instanceof SessionNotFoundError) {
        this.sendExitEvent(client, sessionId, -1)
      }
      throw error
    }
    return {}
  }

  protected resizeSession(
    client: ConnectedDaemonClient | undefined,
    sessionId: string,
    cols: number,
    rows: number
  ): Record<string, never> {
    try {
      this.host.resize(sessionId, cols, rows)
    } catch (error) {
      if (error instanceof SessionNotFoundError) {
        this.sendExitEvent(client, sessionId, -1)
      }
      throw error
    }
    return {}
  }

  protected setSessionBackground(sessionId: string, background: boolean): Record<string, never> {
    recordDaemonStreamBacklogEvent('setSessionBackground', {
      sessionIdSuffix: sessionId.slice(-10),
      background
    })
    const changed = this.transientFactRelay.setSessionBackground(sessionId, background)
    this.streamDataBatcher.refreshSessionDroppability(sessionId)
    if (!changed) {
      return {}
    }
    if (background) {
      this.transientFactRelay.seedSessionScanState(
        sessionId,
        this.host.getPartialEscapeTailAnsi(sessionId)
      )
    }
    const streamClientId = this.streamClientIdBySessionId.get(sessionId)
    if (!streamClientId) {
      return {}
    }
    const mode2031State = this.transientFactRelay.getMode2031ReplyScanState(sessionId)
    const scanSeedAnsi = background
      ? ''
      : mode2031State.pendingSubscribe
        ? mode2031State.tail
        : this.host.getPartialEscapeTailAnsi(sessionId)
    this.streamDataBatcher.enqueueControlEvent(streamClientId, sessionId, {
      type: 'event',
      event: 'sessionBackgroundMarker',
      sessionId,
      payload: {
        background,
        ...(scanSeedAnsi.length > 0 ? { scanSeedAnsi } : {}),
        ...(mode2031State.pendingSubscribe ? { mode2031PendingSubscribe: true as const } : {})
      }
    })
    return {}
  }

  protected async killSession(
    clientId: string,
    payload: Extract<DaemonRequest, { type: 'kill' }>['payload']
  ): Promise<Record<string, never>> {
    const canceledPendingSpawn = this.cancelPendingPtySpawnPreparations(payload.sessionId)
    this.lastInputAtBySessionId.delete(payload.sessionId)
    const attribution = {
      sessionId: payload.sessionId,
      immediate: payload.immediate === true,
      clientId
    }
    try {
      await this.host.kill(payload.sessionId, { immediate: payload.immediate })
    } catch (error) {
      if (!(canceledPendingSpawn && error instanceof SessionNotFoundError)) {
        this.log.log('session-kill-failed', attribution)
        throw error
      }
    }
    this.log.log('session-killed', attribution)
    return {}
  }

  protected getSessionSnapshot(sessionId: string, requestedRows: unknown): { snapshot: unknown } {
    const snapshotStart = performance.now()
    const scrollbackRows =
      typeof requestedRows === 'number' && Number.isFinite(requestedRows)
        ? Math.max(0, Math.min(50_000, Math.floor(requestedRows)))
        : undefined
    const snapshot = this.host.getSnapshot(sessionId, { scrollbackRows })
    const snapshotMs = performance.now() - snapshotStart
    if (snapshotMs >= 25) {
      recordDaemonStreamBacklogEvent('slowGetSnapshot', {
        sessionIdSuffix: sessionId.slice(-10),
        snapshotMs: Math.round(snapshotMs)
      })
    }
    return { snapshot }
  }

  protected sendExitEvent(
    client: ConnectedDaemonClient | undefined,
    sessionId: string,
    code: number
  ): void {
    if (!client?.streamSocket) {
      return
    }
    this.streamDataBatcher.enqueueControlEvent(client.clientId, sessionId, {
      type: 'event',
      event: 'exit',
      sessionId,
      payload: { code }
    })
    this.streamDataBatcher.flush(client.clientId)
  }
}
