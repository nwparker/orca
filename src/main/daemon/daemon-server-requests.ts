import { readCurrentProcessMacSystemResolverHealth } from '../network/macos-system-resolver-health'
import {
  DaemonServerTerminalRequests,
  isTerminalDaemonRequest,
  UNHANDLED_DAEMON_REQUEST
} from './daemon-server-terminal-requests'
import type { DaemonRequest } from './types'

export class DaemonServerRequests extends DaemonServerTerminalRequests {
  protected override async routeRequest(
    clientId: string,
    request: DaemonRequest
  ): Promise<unknown> {
    const terminalResult = this.routeTerminalRequest(clientId, request)
    if (terminalResult !== UNHANDLED_DAEMON_REQUEST) {
      return terminalResult
    }
    if (isTerminalDaemonRequest(request)) {
      throw new Error(`Unknown request type: ${request.type}`)
    }
    const client = this.clients.get(clientId)
    switch (request.type) {
      case 'startHistorySeedTransfer': {
        if (!client?.authenticatedPairEstablished || client.streamSocket === null) {
          throw new Error('Daemon client connection is incomplete; reconnect')
        }
        return { transferId: this.historySeedTransfers.start(clientId, request.payload) }
      }
      case 'appendHistorySeedTransfer':
        this.historySeedTransfers.append(
          clientId,
          request.payload.transferId,
          request.payload.index,
          request.payload.data
        )
        return {}
      case 'finishHistorySeedTransfer':
        this.historySeedTransfers.finish(clientId, request.payload.transferId)
        return {}
      case 'abortHistorySeedTransfer':
        this.historySeedTransfers.abort(clientId, request.payload.transferId)
        return {}
      case 'shutdownIfIdle':
        return this.shutdownIfSoleIdleClient(clientId, request.id)
      case 'ping':
        return { pong: true }
      case 'systemResolverHealth':
        return { health: await readCurrentProcessMacSystemResolverHealth() }
      case 'ptySpawnHealth':
        await this.ptySpawnHealthCheck()
        return { healthy: true }
      case 'shutdown':
        return this.shutdownFromRpc(clientId, request)
    }
    throw new Error(`Unknown request type: ${(request as { type: string }).type}`)
  }

  protected shutdownIfSoleIdleClient(clientId: string, requestId: string): { retiring: boolean } {
    const authenticatedClient = this.clients.get(clientId)
    const retiring =
      authenticatedClient !== undefined &&
      authenticatedClient.streamSocket !== null &&
      this.clients.size === 1 &&
      this.createOrAttachInFlight === 0 &&
      this.host.listSessions().length === 0 &&
      [...this.transportSockets].every(
        (transport) =>
          transport === authenticatedClient.controlSocket ||
          transport === authenticatedClient.streamSocket
      )
    if (!retiring) {
      return { retiring: false }
    }
    this.idleShutdownState = 'shutting-down'
    this.initialAdoptionDeadlineMs = null
    this.retirementRequested = false
    this.cancelInitialAdoptionTimer()
    const serverClose = this.beginServerClose()
    this.deferShutdownUntilReply(clientId, requestId, authenticatedClient.controlSocket, () =>
      this.finishIdleShutdown(serverClose)
    )
    return { retiring: true }
  }

  protected async shutdownFromRpc(
    clientId: string,
    request: Extract<DaemonRequest, { type: 'shutdown' }>
  ): Promise<Record<string, never>> {
    this.log.log('shutdown', {
      reason: 'rpc',
      killSessions: request.payload.killSessions === true
    })
    const serverClose = this.beginOrdinaryShutdownFence()
    if (request.payload.killSessions) {
      try {
        await this.host.dispose()
      } catch (error) {
        this.log.log('shutdown-dispose-failed', {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
    const controlSocket = this.clients.get(clientId)?.controlSocket
    if (controlSocket) {
      this.deferShutdownUntilReply(clientId, request.id, controlSocket, () =>
        this.finishRpcShutdown(serverClose)
      )
    } else if (!this.shutdownPromise) {
      this.shutdownPromise = this.finishRpcShutdown(serverClose)
    }
    return {}
  }
}
