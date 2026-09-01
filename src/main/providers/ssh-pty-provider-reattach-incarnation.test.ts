import { describe, expect, it, vi } from 'vitest'
import { SSH_SOURCE_RESTORE_REQUIRED_ERROR } from './ssh-pty-errors'
import { SshPtyProvider } from './ssh-pty-provider'

describe('SSH PTY provider session reattach incarnation', () => {
  it('remembers the authoritative incarnation before a legacy exit arrives', async () => {
    let notify: ((method: string, params: Record<string, unknown>) => void) | undefined
    const mux = {
      request: vi.fn().mockResolvedValue({ incarnationId: 'incarnation-reattached' }),
      notify: vi.fn(),
      onNotification: vi.fn(
        (callback: (method: string, params: Record<string, unknown>) => void) => {
          notify = callback
          return vi.fn()
        }
      )
    }
    const provider = new SshPtyProvider('conn-1', mux as never)
    const onExit = vi.fn()
    provider.onExit(onExit)

    await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })
    notify?.('pty.exit', { id: 'pty-old', code: 0 })

    expect(onExit).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'ssh:conn-1@@pty-old',
        ptyIncarnation: 'incarnation-reattached'
      })
    )
  })

  it('fails closed after bounded generic reattach restore retries', async () => {
    const mux = {
      request: vi.fn().mockResolvedValue({
        incarnationId: 'incarnation-reattached',
        sourceRecovery: {
          status: 'restoreRequired',
          reason: 'checkpointUnavailable'
        }
      }),
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    await expect(provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' })).rejects.toThrow(
      `${SSH_SOURCE_RESTORE_REQUIRED_ERROR}: pty-old`
    )
    expect(mux.request).toHaveBeenCalledTimes(3)
  })
})
