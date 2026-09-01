import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RelayDispatcher,
  type RelayClientSessionIdentity,
  type RequestContext,
  type SinkWriteSettlement
} from './dispatcher'
import { encodeJsonRpcFrame, MessageType } from './protocol'
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

function responseResult(buffer: Buffer): Record<string, unknown> | null {
  if (buffer[0] !== MessageType.Regular) {
    return null
  }
  const length = buffer.readUInt32BE(9)
  const message = JSON.parse(buffer.subarray(13, 13 + length).toString('utf8'))
  return message.id === undefined ? null : (message.result ?? null)
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
    const writes: Buffer[] = []
    dispatcher = new RelayDispatcher(
      (data, onSettled) => {
        writes.push(Buffer.from(data))
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
    return { adapter, publication, settlements, writes }
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

  it('ignores a stale activation before it can cancel the replacement delivery', async () => {
    const { publication, adapter, settlements } = await createHarness()
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(1, settlements))).toBe('opened')
    settlements[0]({ ok: true })
    const cancelDelivery = vi.spyOn(adapter, 'cancelDelivery')
    const staleSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const staleContext: RequestContext = {
      ...contextOn(0, staleSettlements),
      isStale: () => true
    }

    expect(
      publication.activate('pty-1', 'incarnation-2', staleContext, {
        status: 'checkpoint',
        clientGeneration: 999,
        ownerGeneration: 999,
        ptyIncarnation: 'stale-incarnation',
        deliveryToken: 'stale-token',
        acceptedSourceEndSu: 0
      })
    ).toBe(false)
    expect(cancelDelivery).not.toHaveBeenCalled()
    expect(staleSettlements).toHaveLength(0)
  })

  it('does not release a replacement fence from a stale activation', async () => {
    const { publication, settlements, writes } = await createHarness()
    expect(publication.activate('pty-1', 'incarnation-1', contextOn(0, settlements))).toBe('opened')
    settlements[0]({ ok: true })
    const activation = publication.receivingActivation('pty-1', 1)!
    const ownerGrant = writes.map(responseResult).find((result) => result?.ownerLease)!

    // The old transport arms its rotation fence while waiting for a checkpoint-safe send.
    await expect(publication.waitForPendingSend('pty-1')).resolves.toBe(true)

    const replacementWrites: Buffer[] = []
    const replacementClientId = dispatcher!.attachClient(
      (data, onSettled) => {
        replacementWrites.push(Buffer.from(data))
        onSettled({ ok: true })
        return true
      },
      { supportsWriteCallback: true },
      endpointIdentity
    )
    dispatcher!.feedClient(
      replacementClientId,
      requestFrame(2, 'pty.openClient', {
        protocolVersion: 1,
        clientInstanceId: 'client-1',
        requestedRole: 'session-owner',
        resume: {
          ownerGeneration: ownerGrant.ownerGeneration,
          ownerLease: ownerGrant.ownerLease
        },
        capabilities: { outputFlowControl: { versions: [1], requestedWindowSu: 4 } }
      })
    )
    await flushRequests()

    const replacementSettlements: ((result: SinkWriteSettlement) => void)[] = []
    const recovery = {
      status: 'checkpoint' as const,
      clientGeneration: activation.clientGeneration,
      ownerGeneration: activation.ownerGeneration,
      ptyIncarnation: activation.ptyIncarnation,
      deliveryToken: activation.deliveryToken,
      acceptedSourceEndSu: 0
    }
    expect(
      publication.activate(
        'pty-1',
        'incarnation-1',
        {
          ...contextOn(0, replacementSettlements),
          clientId: replacementClientId
        },
        recovery
      )
    ).toMatchObject({ status: 'pending' })
    replacementSettlements[0]({ ok: true })

    // Arm the replacement fence, then let the old, now-stale activation resume.
    await expect(publication.waitForPendingSend('pty-1')).resolves.toBe(true)
    expect(
      publication.activate(
        'pty-1',
        'incarnation-1',
        {
          ...contextOn(0, []),
          isStale: () => true
        },
        recovery
      )
    ).toBe(false)
    expect(publication.publish('pty-1', { data: 'replacement-output' }, false)).toBe(false)

    // Release the replacement fence through its owning transport so this test leaves no parked work.
    expect(
      publication.activate('pty-1', 'incarnation-1', {
        ...contextOn(0, []),
        clientId: replacementClientId
      })
    ).toBe('existing')
    expect(replacementWrites.length).toBeGreaterThan(0)
  })
})
