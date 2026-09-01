import { afterEach, describe, expect, it } from 'vitest'
import {
  RelayDispatcher,
  type RelayClientSessionIdentity,
  type RequestContext,
  type SinkWriteSettlement
} from './dispatcher'
import { encodeJsonRpcFrame } from './protocol'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

const endpointIdentity: RelayClientSessionIdentity = {
  principal: 'endpoint-principal',
  authenticated: true,
  allowSessionOwner: true,
  authenticationKind: 'endpoint-credential'
}

function requestFrame(id: number, method: string, params: Record<string, unknown>): Buffer {
  return encodeJsonRpcFrame({ jsonrpc: '2.0', id, method, params }, id, 0)
}

async function flushRequests(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('PTY source activation across a transport change', () => {
  let dispatcher: RelayDispatcher | null = null

  afterEach(() => {
    dispatcher?.dispose()
    dispatcher = null
  })

  async function createHarness() {
    const settlements: ((result: SinkWriteSettlement) => void)[] = []
    dispatcher = new RelayDispatcher(
      (_data, onSettled) => {
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    let publication: RelayPtySourcePublication
    const adapter = new SshPtyConsumerSessionAdapter(dispatcher, 'build-a', undefined, (id) =>
      publication.onCreditAvailable(id)
    )
    publication = new RelayPtySourcePublication(dispatcher, adapter, () => {})
    dispatcher.feed(
      requestFrame(1, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()
    return { publication, settlements }
  }

  function contextOn(
    transportGeneration: number | undefined,
    settlements: unknown[]
  ): RequestContext {
    return {
      clientId: 1,
      ...(transportGeneration === undefined ? {} : { transportGeneration }),
      isStale: () => false,
      sessionIdentity: endpointIdentity,
      onResponseSettled: (callback) => settlements.push(callback)
    }
  }

  it('short-circuits same-client activation on the same transport', async () => {
    const { publication, settlements } = await createHarness()
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(0, settlements))).toBe('opened')
    ;(settlements[0] as (result: SinkWriteSettlement) => void)({ ok: true })
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(0, settlements))).toBe(
      'existing'
    )
  })

  it('does not claim existing when the client returns on a new transport', async () => {
    const { publication, settlements } = await createHarness()
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(0, settlements))).toBe('opened')
    ;(settlements[0] as (result: SinkWriteSettlement) => void)({ ok: true })
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(1, settlements))).not.toBe(
      'existing'
    )
  })

  it('keeps id-only behavior for callers without transport generations', async () => {
    const { publication, settlements } = await createHarness()
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(undefined, settlements))).toBe(
      'opened'
    )
    ;(settlements[0] as (result: SinkWriteSettlement) => void)({ ok: true })
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(undefined, settlements))).toBe(
      'existing'
    )
  })
})
