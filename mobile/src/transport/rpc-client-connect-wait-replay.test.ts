import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { connect } from './rpc-client'
import { useMobileSessionTerminalInput } from '../session/use-mobile-session-terminal-input'
import { mountFixture } from '../test-support/rpc-recording/recorder-fixture-shape'

vi.mock('./direct-e2ee-framing-policy', () => import('./legacy-direct-framing-test-policy'))

vi.mock('./e2ee', () => ({
  generateKeyPair: () => ({
    publicKey: new Uint8Array(32),
    secretKey: new Uint8Array(32)
  }),
  deriveSharedKey: () => new Uint8Array(32),
  publicKeyFromBase64: () => new Uint8Array(32),
  publicKeyToBase64: () => 'client-public-key',
  encrypt: (plaintext: string) => `encrypted:${plaintext}`,
  decrypt: (raw: string) => raw.replace(/^encrypted:/, ''),
  decryptBytes: (bytes: Uint8Array) => bytes
}))

vi.mock('./mobile-runtime-capability-negotiation', () => ({
  negotiateMobileRuntimeCapabilities: (args: { onReady: () => void }) => args.onReady()
}))

class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSED = 3

  readonly CONNECTING = MockWebSocket.CONNECTING
  readonly OPEN = MockWebSocket.OPEN
  readonly CLOSED = MockWebSocket.CLOSED

  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: string[] = []
  close = vi.fn(() => {
    if (this.readyState === MockWebSocket.CLOSED) {
      return
    }
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  })

  constructor(readonly endpoint: string) {
    mockSockets.push(this)
  }

  send(payload: string): void {
    this.sent.push(payload)
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
    this.receive(JSON.stringify({ type: 'e2ee_ready' }))
    this.receive('encrypted:{"type":"e2ee_authenticated"}')
  }

  receive(payload: unknown): void {
    this.onmessage?.({ data: payload })
  }
}

const mockSockets: MockWebSocket[] = []
const originalWebSocket = globalThis.WebSocket

function track(request: Promise<unknown>): { read: () => string } {
  let outcome = 'pending'
  request.then(
    () => {
      outcome = 'resolved'
    },
    (error: Error) => {
      outcome = error.message
    }
  )
  return { read: () => outcome }
}

function terminalSendFrames(socket: MockWebSocket): string[] {
  return socket.sent.filter((frame) => frame.includes('terminal.send'))
}

describe('mobile rpc-client connect-wait replay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSockets.length = 0
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket
  })

  afterEach(() => {
    vi.useRealTimers()
    globalThis.WebSocket = originalWebSocket
  })

  it('does not replay a terminal Clear after the connection drops before delivery', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    const terminal = { clear: vi.fn() }
    const showToast = vi.fn()
    const subscribeToTerminal = vi.fn()
    let clearHost: (() => Promise<void>) | undefined
    function Harness() {
      const actions = useMobileSessionTerminalInput(
        mountFixture<Parameters<typeof useMobileSessionTerminalInput>[0]>({
          client,
          clientRef: { current: client },
          showToast,
          getTerminalRef: () => terminal,
          unsubscribeTerminal: vi.fn(),
          subscribeToTerminal
        })
      )
      clearHost = () =>
        actions.handleClearTerminal({ handle: 't1', title: 'Shell', isActive: true })
      return null
    }
    let tree: ReturnType<typeof create> | undefined
    act(() => {
      tree = create(createElement(Harness))
    })
    socket.close()
    try {
      const pending = clearHost?.()
      await vi.advanceTimersByTimeAsync(0)
      expect(showToast.mock.calls).toEqual([["Couldn't clear terminal", 1500]])
      await vi.advanceTimersByTimeAsync(500)
      mockSockets[1]!.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(
        mockSockets[1]!.sent.filter((frame) => frame.includes('terminal.clearBuffer'))
      ).toEqual([])
      expect(subscribeToTerminal).not.toHaveBeenCalled()
      expect(terminal.clear).not.toHaveBeenCalled()
      await pending
    } finally {
      act(() => tree?.unmount())
      client.close()
    }
  })

  it('Given a cut connection When a send opts into failWhenDisconnected Then it rejects now and nothing replays after reconnect', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    socket.close()

    const request = client.sendRequest(
      'terminal.send',
      { terminal: 't1', text: 'YZZY' },
      { failWhenDisconnected: true }
    )
    const outcome = track(request)

    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(outcome.read()).toBe('Not connected: terminal.send')

      // Reconnect; the rejected keystroke must not ride the new socket.
      await vi.advanceTimersByTimeAsync(500)
      mockSockets[1]!.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(terminalSendFrames(mockSockets[1]!)).toEqual([])
    } finally {
      client.close()
      await request.catch(() => undefined)
    }
  })

  it('Given a cut connection When a caller does not opt in Then the send parks and is delivered on the next socket', async () => {
    const client = connect('ws://desktop.invalid', 'token', 'server-key')
    const socket = mockSockets[0]!
    socket.open()
    socket.close()

    // Pins the default behavior that motivates the opt-out: parked requests
    // replay after reconnect, which is what corrupted post-recovery input.
    const request = client.sendRequest('terminal.send', { terminal: 't1', text: 'YZZY' })
    const outcome = track(request)

    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(outcome.read()).toBe('pending')

      await vi.advanceTimersByTimeAsync(500)
      mockSockets[1]!.open()
      await vi.advanceTimersByTimeAsync(0)
      expect(terminalSendFrames(mockSockets[1]!)).toHaveLength(1)
    } finally {
      client.close()
      await request.catch(() => undefined)
    }
  })
})
