import {
  isAgentSessionExecutionClaim,
  isAgentSessionSurfaceBinding
} from '../../shared/agent-session-host-authority'
import { parsePtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { recordDaemonStreamBacklogEvent } from './daemon-stream-backlog-probe'
import { DAEMON_ENDPOINT_LOST_MESSAGE } from './daemon-endpoint-ownership'
import { DaemonServerConnections } from './daemon-server-connections'
import type { PendingPtySpawnPreparation } from './daemon-server-runtime'
import { TerminalAttachCanceledError, type DaemonRequest } from './types'
import type { CreateOrAttachResult } from './terminal-host'

type CreateOrAttachRequest = Extract<DaemonRequest, { type: 'createOrAttach' }>

export class DaemonServerAdmission extends DaemonServerConnections {
  protected async createOrAttachSession(
    clientId: string,
    request: CreateOrAttachRequest
  ): Promise<unknown> {
    const client = this.clients.get(clientId)
    if (this.idleShutdownState !== 'running') {
      throw new Error('Daemon temporarily unavailable; reconnect')
    }
    if (!client?.authenticatedPairEstablished || client.streamSocket === null) {
      throw new Error('Daemon client connection is incomplete; reconnect')
    }
    const payload = request.payload
    const attachOnly = payload.attachOnly === true
    if (!attachOnly && this.hasLostEndpointOwnership()) {
      this.requestRetirementForLostEndpoint()
      throw new Error(DAEMON_ENDPOINT_LOST_MESSAGE)
    }
    this.createOrAttachInFlight++
    let routedSessionId = payload.sessionId
    let spawnPreparation: PendingPtySpawnPreparation | null = null
    let result!: CreateOrAttachResult
    try {
      if (
        payload.agentSessionEnsure !== undefined &&
        (!isAgentSessionExecutionClaim(payload.agentSessionEnsure.claim) ||
          !isAgentSessionSurfaceBinding(payload.agentSessionEnsure.surface))
      ) {
        throw new Error('agent_session_identity_required')
      }
      spawnPreparation = this.registerPtySpawnPreparation(
        payload.sessionId,
        clientId,
        request.id,
        payload.cancelAfterMs
      )
      if (!attachOnly) {
        await this.preparePtySpawnUnlessCanceled(payload.sessionId, spawnPreparation)
      }
      if (payload.historySeed !== undefined && payload.historySeedTransferId !== undefined) {
        throw new Error('Multiple terminal history seed sources')
      }
      const historySeedChunks =
        payload.historySeedTransferId !== undefined
          ? this.historySeedTransfers.take(clientId, payload.historySeedTransferId)
          : payload.historySeed !== undefined
            ? [payload.historySeed]
            : undefined
      result = await this.host.createOrAttach({
        sessionId: payload.sessionId,
        cols: payload.cols,
        rows: payload.rows,
        cwd: payload.cwd,
        env: payload.env,
        envToDelete: payload.envToDelete,
        command: payload.command,
        startupCommandDelivery: payload.startupCommandDelivery,
        ...(attachOnly ? { attachOnly: true } : {}),
        ...(isTuiAgent(payload.launchAgent) ? { launchAgent: payload.launchAgent } : {}),
        shellOverride: payload.shellOverride,
        terminalWindowsWslDistro: payload.terminalWindowsWslDistro,
        terminalWindowsPowerShellImplementation: payload.terminalWindowsPowerShellImplementation,
        shellReadySupported: payload.shellReadySupported,
        historySeedChunks,
        startupIngress: parsePtyStartupIngressIntent(payload.startupIngress),
        ...(payload.shellReadyTimeoutMs !== undefined
          ? { shellReadyTimeoutMs: payload.shellReadyTimeoutMs }
          : {}),
        ...(payload.agentSessionEnsure ? { agentSessionEnsure: payload.agentSessionEnsure } : {}),
        isCanceled: () => spawnPreparation?.canceled === true,
        cancelSignal: spawnPreparation.controller.signal,
        onSessionResolved: (sessionId) => {
          routedSessionId = sessionId
        },
        streamClient: {
          onData: (data, rawLength = data.length, transformed = false, seq) => {
            this.transientFactRelay.onSessionData(routedSessionId, data)
            this.streamDataBatcher.enqueue(clientId, routedSessionId, data, {
              flushImmediately: this.isInteractiveOutput(routedSessionId, data),
              flushMaxChars: DaemonServerAdmission.INTERACTIVE_OUTPUT_MAX_CHARS,
              rawLength,
              transformed,
              seq
            })
          },
          onExit: (code, incarnationId, cause) => {
            this.log.log('session-exited', {
              sessionId: routedSessionId,
              code,
              cause: cause?.kind
            })
            this.streamDataBatcher.enqueueControlEvent(clientId, routedSessionId, {
              type: 'event',
              event: 'exit',
              sessionId: routedSessionId,
              payload: { code, incarnationId, ...(cause ? { cause } : {}) }
            })
            this.streamDataBatcher.flush(clientId)
            recordDaemonStreamBacklogEvent('sessionExit', {
              sessionIdSuffix: routedSessionId.slice(-10)
            })
            this.transientFactRelay.onSessionExit(routedSessionId)
            this.streamDataBatcher.refreshSessionDroppability(routedSessionId)
            this.streamClientIdBySessionId.delete(routedSessionId)
            this.attachTokenBySessionId.delete(routedSessionId)
            this.lastInputAtBySessionId.delete(routedSessionId)
            this.reevaluateIdleShutdown()
          }
        }
      })
    } finally {
      if (spawnPreparation) {
        this.finishPtySpawnPreparation(payload.sessionId, spawnPreparation)
      }
      this.createOrAttachInFlight--
      this.reevaluateIdleShutdown()
    }
    routedSessionId = result.agentSessionEnsure?.owner.ptyId ?? payload.sessionId
    if (
      this.clients.get(clientId) !== client ||
      !client.authenticatedPairEstablished ||
      client.streamSocket === null
    ) {
      this.host.detach(routedSessionId, result.attachToken)
      throw new TerminalAttachCanceledError(routedSessionId)
    }
    this.streamClientIdBySessionId.set(routedSessionId, clientId)
    this.attachTokenBySessionId.set(routedSessionId, result.attachToken)
    this.streamDataBatcher.refreshSessionDroppability(routedSessionId)
    if (this.transientFactRelay.isBackgrounded(routedSessionId)) {
      this.streamDataBatcher.enqueueControlEvent(clientId, routedSessionId, {
        type: 'event',
        event: 'sessionBackgroundMarker',
        sessionId: routedSessionId,
        payload: { background: true }
      })
    }
    this.log.log(result.isNew ? 'session-created' : 'session-attached', {
      sessionId: routedSessionId,
      pid: result.pid
    })
    return {
      isNew: result.isNew,
      snapshot: result.snapshot,
      pid: result.pid,
      shellState: result.shellState,
      incarnationId: result.incarnationId,
      ...(result.launchAgent ? { launchAgent: result.launchAgent } : {}),
      wslDistro: result.wslDistro,
      ...(result.historySeeded !== undefined ? { historySeeded: result.historySeeded } : {}),
      ...(result.agentSessionEnsure ? { agentSessionEnsure: result.agentSessionEnsure } : {})
    }
  }
}
