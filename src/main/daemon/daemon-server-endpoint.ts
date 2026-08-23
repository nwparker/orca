import { chmodSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import {
  DaemonEndpointUnavailableError,
  getDaemonSocketBindPath,
  publishDaemonEndpoint,
  readDaemonEndpointOwnershipState,
  type DaemonEndpointOwnershipState
} from './daemon-endpoint-ownership'
import { probeSocketConnect } from './daemon-endpoint-probe'
import { unlinkOwnedDaemonPidFile } from './daemon-spawner'
import { CLEAN_DISCONNECT_PROTOCOL_VERSION } from './types'
import { DaemonServerShutdown } from './daemon-server-shutdown'

export abstract class DaemonServerEndpoint extends DaemonServerShutdown {
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = createServer((socket) => this.handleConnection(socket))
      let startupSettled = false
      const onServerError = (error: Error): void => {
        if (startupSettled) {
          this.log.log('server-error', { message: error.message })
          console.warn(`[daemon] Socket server error: ${error.message}`)
          return
        }
        startupSettled = true
        this.startupFailure = error
        reject(error)
      }
      this.server.on('error', onServerError)
      const bindPath =
        process.platform === 'win32' ? this.socketPath : getDaemonSocketBindPath(this.socketPath)
      this.server.listen(bindPath, () => {
        try {
          chmodSync(bindPath, 0o600)
        } catch {
          // Best-effort on platforms that support it.
        }
        const abandonStartup = (error: unknown): void => {
          startupSettled = true
          const server = this.server
          this.server = null
          reject(error)
          server?.close()
          if (process.platform !== 'win32') {
            try {
              unlinkSync(bindPath)
            } catch {
              // Publication already consumed the private bind name.
            }
          }
        }
        void this.publishAndArm(bindPath).then(() => {
          if (this.startupFailure) {
            this.retireUnstartedDaemon()
            abandonStartup(this.startupFailure)
            return
          }
          startupSettled = true
          resolve()
        }, abandonStartup)
      })
    })
  }

  protected async publishAndArm(bindPath: string): Promise<void> {
    const outcome = await publishDaemonEndpoint(bindPath, this.socketPath, probeSocketConnect)
    if (outcome.status !== 'published') {
      this.log.log('endpoint-publish-declined', { reason: outcome.status })
      console.warn(`[daemon] Endpoint unavailable at startup: reason=${outcome.status}`)
      throw new DaemonEndpointUnavailableError(outcome.status)
    }
    this.ownedSocketIdentity = outcome.identity
    let publishedOwnership = false
    try {
      this.publishEndpointOwnership()
      publishedOwnership = true
      writeFileSync(this.tokenPath, this.token, { mode: 0o600 })
    } catch (error) {
      if (publishedOwnership && this.pidPath && this.launchNonce) {
        unlinkOwnedDaemonPidFile(this.pidPath, process.pid, this.launchNonce)
      }
      this.ownedSocketIdentity = null
      throw error
    }
    if (this.protocolVersion >= CLEAN_DISCONNECT_PROTOCOL_VERSION) {
      this.armInitialAdoptionTimeout()
    }
    this.startEndpointOwnershipWatch()
  }

  protected retireUnstartedDaemon(): void {
    this.stopEndpointOwnershipWatch()
    this.cancelInitialAdoptionTimer()
    this.unlinkOwnedEndpointArtifacts()
  }

  protected startEndpointOwnershipWatch(): void {
    if (process.platform === 'win32' || !this.ownedSocketIdentity) {
      return
    }
    this.endpointOwnershipTimer = setInterval(
      () => this.checkEndpointOwnership(),
      DaemonServerEndpoint.ENDPOINT_OWNERSHIP_POLL_MS
    )
    this.endpointOwnershipTimer.unref()
  }

  protected checkEndpointOwnership(): void {
    if (process.platform === 'win32' || !this.ownedSocketIdentity || this.shutdownPromise) {
      return
    }
    if (this.observeEndpointOwnership() !== 'lost') {
      return
    }
    this.endpointOwnershipLossStreak++
    if (
      this.endpointOwnershipLossStreak < DaemonServerEndpoint.ENDPOINT_OWNERSHIP_LOSS_CONFIRMATIONS
    ) {
      return
    }
    this.requestRetirementForLostEndpoint()
  }

  protected hasLostEndpointOwnership(): boolean {
    if (this.endpointOwnershipLost) {
      return true
    }
    return this.observeEndpointOwnership() === 'lost'
  }

  protected observeEndpointOwnership(): DaemonEndpointOwnershipState {
    if (
      process.platform === 'win32' ||
      !this.ownedSocketIdentity ||
      this.idleShutdownState !== 'running'
    ) {
      return 'indeterminate'
    }
    const state = readDaemonEndpointOwnershipState(this.socketPath, this.ownedSocketIdentity)
    if (state !== 'lost') {
      this.endpointOwnershipLossStreak = 0
    }
    return state
  }

  protected requestRetirementForLostEndpoint(): void {
    const alreadyLost = this.endpointOwnershipLost
    this.endpointOwnershipLost = true
    this.ownedSocketIdentity = null
    if (!alreadyLost) {
      this.log.log('endpoint-ownership-lost', { socketPath: this.socketPath })
      console.warn(
        '[daemon] Endpoint ownership lost to another daemon — retiring once existing sessions end'
      )
    }
    this.retirementRequested = true
    this.stopEndpointOwnershipWatch()
    this.reevaluateIdleShutdown()
  }
}
