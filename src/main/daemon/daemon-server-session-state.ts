import { TerminalAttachCanceledError } from './types'
import {
  cancelPtySpawnPreparation,
  DaemonServerRuntime,
  type PendingPtySpawnPreparation
} from './daemon-server-runtime'

export abstract class DaemonServerSessionState extends DaemonServerRuntime {
  protected registerPtySpawnPreparation(
    sessionId: string,
    clientId: string,
    requestId: string,
    cancelAfterMs: unknown
  ): PendingPtySpawnPreparation {
    const preparation: PendingPtySpawnPreparation = {
      canceled: false,
      controller: new AbortController(),
      clientId,
      requestId
    }
    if (Number.isSafeInteger(cancelAfterMs) && Number(cancelAfterMs) > 0) {
      preparation.cancelTimer = setTimeout(
        () => cancelPtySpawnPreparation(preparation),
        Math.min(Number(cancelAfterMs), 300_000)
      )
      preparation.cancelTimer.unref()
    }
    const pending = this.pendingPtySpawnPreparations.get(sessionId) ?? new Set()
    pending.add(preparation)
    this.pendingPtySpawnPreparations.set(sessionId, pending)
    return preparation
  }

  protected async preparePtySpawnUnlessCanceled(
    sessionId: string,
    preparation: PendingPtySpawnPreparation
  ): Promise<void> {
    await this.preparePtySpawn()
    if (preparation.canceled) {
      throw new TerminalAttachCanceledError(sessionId)
    }
  }

  protected finishPtySpawnPreparation(
    sessionId: string,
    preparation: PendingPtySpawnPreparation
  ): void {
    if (preparation.cancelTimer) {
      clearTimeout(preparation.cancelTimer)
    }
    const pending = this.pendingPtySpawnPreparations.get(sessionId)
    pending?.delete(preparation)
    if (pending?.size === 0) {
      this.pendingPtySpawnPreparations.delete(sessionId)
    }
  }

  protected cancelPendingPtySpawnPreparations(
    sessionId: string,
    request?: { clientId: string; requestId?: string }
  ): boolean {
    const pending = this.pendingPtySpawnPreparations.get(sessionId)
    if (!pending) {
      return false
    }
    let canceled = false
    for (const preparation of pending) {
      if (
        request &&
        (preparation.clientId !== request.clientId ||
          (request.requestId !== undefined && preparation.requestId !== request.requestId))
      ) {
        continue
      }
      cancelPtySpawnPreparation(preparation)
      canceled = true
    }
    return canceled
  }

  protected cancelAllPendingPtySpawnPreparations(): void {
    for (const sessionId of this.pendingPtySpawnPreparations.keys()) {
      this.cancelPendingPtySpawnPreparations(sessionId)
    }
  }

  protected cancelPendingPtySpawnPreparationsForClient(clientId: string): void {
    for (const pending of this.pendingPtySpawnPreparations.values()) {
      for (const preparation of pending) {
        if (preparation.clientId === clientId) {
          cancelPtySpawnPreparation(preparation)
        }
      }
    }
  }

  protected detachClientSessions(clientId: string): void {
    const attachments: { sessionId: string; token: symbol }[] = []
    for (const [sessionId, attachedClientId] of this.streamClientIdBySessionId) {
      if (attachedClientId !== clientId) {
        continue
      }
      const token = this.attachTokenBySessionId.get(sessionId)
      if (token) {
        attachments.push({ sessionId, token })
      }
      this.streamClientIdBySessionId.delete(sessionId)
      this.attachTokenBySessionId.delete(sessionId)
    }
    if (attachments.length > 0) {
      this.host.detachClients(attachments)
    }
  }

  protected detachSessionForClient(sessionId: string, clientId: string): void {
    if (this.streamClientIdBySessionId.get(sessionId) !== clientId) {
      return
    }
    const token = this.attachTokenBySessionId.get(sessionId)
    if (token) {
      this.host.detach(sessionId, token)
    }
    this.streamClientIdBySessionId.delete(sessionId)
    this.attachTokenBySessionId.delete(sessionId)
  }
}
