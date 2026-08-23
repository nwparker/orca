import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { DaemonClient } from './client'
import { PROTOCOL_VERSION, type ListSessionsResult } from './types'

export function probeDaemonSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve(false)
      return
    }
    const socket = connect({ path: socketPath })
    let settled = false
    let timer: ReturnType<typeof setTimeout>
    const finish = (alive: boolean, destroy = false): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.removeListener('connect', onConnect)
      socket.removeListener('error', onError)
      if (destroy) {
        socket.destroy()
      }
      resolve(alive)
    }
    const onConnect = (): void => finish(true, true)
    const onError = (): void => finish(false)
    timer = setTimeout(() => finish(false, true), 1_000)
    socket.on('connect', onConnect)
    socket.on('error', onError)
  })
}

export async function getAliveDaemonSessionCount(
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<number | null> {
  const client = new DaemonClient({ socketPath, tokenPath, protocolVersion })
  try {
    await client.ensureConnected()
    const result = await client.request<ListSessionsResult>('listSessions', undefined)
    return result.sessions.filter((session) => session.isAlive).length
  } catch {
    return null
  } finally {
    client.disconnect()
  }
}

export async function waitForDaemonEndpointExit(
  socketPath: string,
  waitMs: number
): Promise<boolean> {
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    if (!(await probeDaemonSocket(socketPath))) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !(await probeDaemonSocket(socketPath))
}
