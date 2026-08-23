import type { Socket } from 'node:net'
import { StringDecoder } from 'node:string_decoder'
import { createNdjsonParser, encodeNdjson } from './ndjson'
import { NOTIFY_PREFIX, type DaemonRequest, type HelloMessage } from './types'
import { DaemonServerEndpoint } from './daemon-server-endpoint'
import type { ConnectedDaemonClient } from './daemon-server-runtime'

export class DaemonServerConnections extends DaemonServerEndpoint {
  protected override handleConnection(socket: Socket): void {
    this.cancelInitialAdoptionTimer()
    this.transportSockets.add(socket)
    socket.once('close', () => {
      this.transportSockets.delete(socket)
      this.reevaluateIdleShutdown()
    })
    socket.on('error', () => socket.destroy())
    if (this.idleShutdownState !== 'running') {
      socket.end(
        encodeNdjson({
          type: 'hello',
          ok: false,
          error: 'Daemon temporarily unavailable; reconnect',
          retryable: true
        })
      )
      return
    }
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (message) => this.handleFirstMessage(socket, message),
      () => socket.destroy()
    )
    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))
  }

  protected handleFirstMessage(socket: Socket, message: unknown): void {
    const hello = message as HelloMessage
    if (hello.type !== 'hello') {
      this.log.log('client-hello-rejected', { reason: 'expected-hello' })
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Expected hello' }))
      socket.destroy()
      return
    }
    if (hello.version !== this.protocolVersion) {
      this.log.log('client-hello-rejected', {
        reason: 'protocol-mismatch',
        clientVersion: hello.version
      })
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Protocol version mismatch' }))
      socket.destroy()
      return
    }
    if (hello.token !== this.token) {
      this.log.log('client-hello-rejected', { reason: 'invalid-token', role: hello.role })
      socket.write(encodeNdjson({ type: 'hello', ok: false, error: 'Invalid token' }))
      socket.destroy()
      return
    }
    this.log.log('client-hello-accepted', { role: hello.role, clientId: hello.clientId })
    socket.write(
      encodeNdjson({
        type: 'hello',
        ok: true,
        ...(this.launchNonce && this.startedAtMs
          ? {
              daemonIdentity: {
                pid: process.pid,
                startedAtMs: this.startedAtMs,
                launchNonce: this.launchNonce,
                ...(this.entryPath ? { entryPath: this.entryPath } : {}),
                ...(this.appVersion ? { appVersion: this.appVersion } : {}),
                ...(this.spawnerExecPath ? { spawnerExecPath: this.spawnerExecPath } : {})
              }
            }
          : {})
      })
    )
    if (hello.role === 'control') {
      this.adoptControlSocket(socket, hello.clientId)
      return
    }
    const client = this.clients.get(hello.clientId)
    if (!client) {
      socket.destroy()
      return
    }
    this.setupStreamSocket(socket, client)
    client.authenticatedPairEstablished = true
    this.onAuthenticatedClientPair()
    this.initialAdoptionDeadlineMs = null
    this.cancelInitialAdoptionTimer()
    if (!this.endpointOwnershipLost) {
      this.retirementRequested = false
    }
  }

  protected adoptControlSocket(socket: Socket, clientId: string): void {
    const previous = this.clients.get(clientId)
    const client: ConnectedDaemonClient = {
      clientId,
      controlSocket: socket,
      streamSocket: null,
      authenticatedPairEstablished: false
    }
    this.clients.set(clientId, client)
    this.setupControlSocket(socket, clientId)
    if (!previous) {
      return
    }
    this.cancelPendingPtySpawnPreparationsForClient(clientId)
    this.historySeedTransfers.clearOwner(clientId)
    this.recordFullyAuthenticatedDisconnect(previous.authenticatedPairEstablished)
    previous.streamSocket?.destroy()
    previous.controlSocket.destroy()
  }

  protected setupControlSocket(socket: Socket, clientId: string): void {
    const decoder = new StringDecoder('utf8')
    const parser = createNdjsonParser(
      (message) => void this.handleRequest(socket, clientId, message as DaemonRequest),
      () => {}
    )
    socket.removeAllListeners('data')
    socket.on('data', (chunk) => parser.feed(decoder.write(chunk)))
    socket.on('close', () => {
      const client = this.clients.get(clientId)
      if (client?.controlSocket !== socket) {
        return
      }
      this.cancelPendingPtySpawnPreparationsForClient(clientId)
      this.historySeedTransfers.clearOwner(clientId)
      const wasFullyAuthenticated = client.authenticatedPairEstablished
      this.streamDataBatcher.clear(clientId)
      this.detachClientSessions(clientId)
      client.streamSocket?.destroy()
      this.clients.delete(clientId)
      this.recordFullyAuthenticatedDisconnect(wasFullyAuthenticated)
      this.reevaluateIdleShutdown()
    })
  }

  protected setupStreamSocket(socket: Socket, client: ConnectedDaemonClient): void {
    const previous = client.streamSocket
    socket.removeAllListeners('data')
    client.streamSocket = socket
    socket.on('drain', () => this.streamDataBatcher.flush(client.clientId))
    const cleanup = (): void => {
      socket.removeListener('close', cleanup)
      socket.removeListener('error', cleanup)
      if (this.clients.get(client.clientId) !== client || client.streamSocket !== socket) {
        return
      }
      this.cancelPendingPtySpawnPreparationsForClient(client.clientId)
      this.streamDataBatcher.clear(client.clientId)
      this.detachClientSessions(client.clientId)
      client.streamSocket = null
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)
    if (previous && previous !== socket) {
      previous.destroy()
    }
  }

  protected async handleRequest(
    socket: Socket,
    clientId: string,
    request: DaemonRequest
  ): Promise<void> {
    const isNotify = request.id.startsWith(NOTIFY_PREFIX)
    try {
      const result = await this.routeRequest(clientId, request)
      if (!isNotify) {
        const pendingShutdown = this.pendingShutdownReplies.get(
          this.shutdownReplyKey(clientId, request.id)
        )
        socket.write(encodeNdjson({ id: request.id, ok: true, payload: result }), () => {
          pendingShutdown?.start()
        })
      }
    } catch (error) {
      if (!isNotify) {
        socket.write(
          encodeNdjson({
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error)
          })
        )
      }
    }
  }

  protected async routeRequest(_clientId: string, request: DaemonRequest): Promise<unknown> {
    throw new Error(`Unknown request type: ${(request as { type: string }).type}`)
  }
}
