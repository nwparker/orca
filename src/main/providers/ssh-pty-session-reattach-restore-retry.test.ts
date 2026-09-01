import { describe, expect, it, vi } from 'vitest'
import { SSH_SESSION_EXPIRED_ERROR, SSH_SOURCE_RESTORE_REQUIRED_ERROR } from './ssh-pty-errors'
import { reattachSshPtySession, requestSshPtyAttach } from './ssh-pty-session-reattach'
import { reattachSshPtySessionForSpawn } from './ssh-pty-session-reattach-for-spawn'
import { SshPtyProvider } from './ssh-pty-provider'
import { SshPtySpawnExitRaceTracker } from './ssh-pty-spawn-exit-race'

const restoreRequired = {
  incarnationId: 'incarnation-live',
  sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' }
}

describe('SSH PTY session reattach restore retry', () => {
  it('reattaches after restoreRequired and returns replay from the live PTY', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(restoreRequired)
      .mockResolvedValueOnce({ incarnationId: 'incarnation-live', replay: 'scrollback' })

    const result = await reattachSshPtySession({
      mux: { request } as never,
      connectionId: 'conn-1',
      sessionId: 'pty-live',
      options: { cols: 80, rows: 24, sessionId: 'pty-live' }
    })

    expect(request).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({
      id: 'ssh:conn-1@@pty-live',
      isReattach: true,
      replay: 'scrollback',
      incarnationId: 'incarnation-live'
    })
    expect(result.sourceRecovery).toBeUndefined()
  })

  it('rolls back a provisional source lease before retrying', async () => {
    const sourceActivation = {
      status: 'pending',
      clientGeneration: 1,
      ownerGeneration: 1,
      ptyIncarnation: 'incarnation-live',
      deliveryToken: 'token-1',
      checkpointSourceEndSu: 0,
      recoveryEndSu: 0
    }
    const request = vi
      .fn()
      .mockResolvedValueOnce({ ...restoreRequired, sourceActivation })
      .mockResolvedValueOnce({ incarnationId: 'incarnation-live', replay: 'scrollback' })
    const rollback = vi.fn().mockResolvedValue(true)
    const installSourceActivation = vi.fn().mockReturnValue({ commit: vi.fn(), rollback })

    const result = await reattachSshPtySession({
      mux: { request } as never,
      connectionId: 'conn-1',
      sessionId: 'pty-live',
      options: { cols: 80, rows: 24, sessionId: 'pty-live' },
      installSourceActivation
    })

    expect(rollback).toHaveBeenCalledOnce()
    expect(result.replay).toBe('scrollback')
  })

  it('stops before retrying when stale-delivery cancellation is unconfirmed', async () => {
    const sourceActivation = {
      status: 'pending',
      clientGeneration: 1,
      ownerGeneration: 1,
      ptyIncarnation: 'incarnation-live',
      deliveryToken: 'token-1',
      checkpointSourceEndSu: 0,
      recoveryEndSu: 0
    }
    const request = vi.fn().mockResolvedValue({ ...restoreRequired, sourceActivation })
    const rollback = vi.fn().mockResolvedValue(false)

    const result = await reattachSshPtySession({
      mux: { request } as never,
      connectionId: 'conn-1',
      sessionId: 'pty-live',
      options: { cols: 80, rows: 24, sessionId: 'pty-live' },
      installSourceActivation: vi.fn().mockReturnValue({ commit: vi.fn(), rollback })
    })

    expect(request).toHaveBeenCalledOnce()
    expect(rollback).toHaveBeenCalledOnce()
    expect(result.sourceRecovery).toMatchObject({ status: 'restoreRequired' })
  })

  it('waits for provisional delivery rollback before returning a restore failure', async () => {
    let finishRollback!: (result: boolean) => void
    const finalRollback = new Promise<boolean>((resolve) => {
      finishRollback = resolve
    })
    let rollbackCalls = 0
    const rollback = vi.fn(() => {
      rollbackCalls += 1
      // The first two restore attempts are retried by reattach; the third lease is
      // returned to the spawn wrapper, which must await its cancellation.
      return rollbackCalls < 3 ? Promise.resolve(true) : finalRollback
    })
    const attachResult = {
      incarnationId: 'incarnation-live',
      sourceRecovery: { status: 'restoreRequired', reason: 'checkpointUnavailable' },
      sourceActivation: {
        status: 'pending',
        clientGeneration: 1,
        ownerGeneration: 1,
        ptyIncarnation: 'incarnation-live',
        deliveryToken: 'token-1',
        checkpointSourceEndSu: 0,
        recoveryEndSu: 0
      }
    }
    const request = vi.fn(
      (
        _method: string,
        _params: Record<string, unknown>,
        options?: { beforeResolve?: (value: unknown) => void }
      ) => {
        // SshChannelMultiplexer installs the provisional lease before resolving the response.
        options?.beforeResolve?.(attachResult)
        return Promise.resolve(attachResult)
      }
    )
    const spawn = reattachSshPtySessionForSpawn({
      mux: { request } as never,
      connectionId: 'conn-1',
      sessionId: 'pty-live',
      options: { cols: 80, rows: 24, sessionId: 'pty-live' },
      exitRaceTracker: new SshPtySpawnExitRaceTracker(),
      acceptLivePty: vi.fn(),
      installSourceActivation: vi.fn().mockReturnValue({ commit: vi.fn(), rollback })
    })

    await vi.waitFor(() => expect(rollback).toHaveBeenCalledTimes(3))
    let settled = false
    void spawn.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    finishRollback(true)
    await expect(spawn).rejects.toThrow(`${SSH_SOURCE_RESTORE_REQUIRED_ERROR}: pty-live`)
  })

  it('waits for rollback when attach rejects after installing a provisional lease', async () => {
    let finishRollback!: (result: boolean) => void
    const rollbackResult = new Promise<boolean>((resolve) => {
      finishRollback = resolve
    })
    const attachResult = {
      incarnationId: 'incarnation-live',
      sourceActivation: {
        status: 'pending' as const,
        clientGeneration: 1,
        ownerGeneration: 1,
        ptyIncarnation: 'incarnation-live',
        deliveryToken: 'token-1',
        checkpointSourceEndSu: 0,
        recoveryEndSu: 0
      }
    }
    const rollback = vi.fn(() => rollbackResult)
    const request = vi.fn(
      (
        _method: string,
        _params: Record<string, unknown>,
        options?: { beforeResolve?: (value: unknown) => void }
      ) => {
        options?.beforeResolve?.(attachResult)
        return Promise.reject(new Error('attach transport lost'))
      }
    )
    const attach = requestSshPtyAttach({
      mux: { request } as never,
      relayPtyId: 'pty-live',
      params: { id: 'pty-live' },
      installSourceActivation: vi.fn().mockReturnValue({
        commit: vi.fn(),
        rollback
      })
    })

    await vi.waitFor(() => expect(rollback).toHaveBeenCalledOnce())
    let settled = false
    void attach.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await Promise.resolve()
    expect(settled).toBe(false)

    finishRollback(true)
    await expect(attach).rejects.toThrow('attach transport lost')
  })

  it('uses a distinct live-source verdict after bounded restore retries', async () => {
    const mux = {
      request: vi.fn().mockResolvedValue(restoreRequired),
      notify: vi.fn(),
      onNotification: vi.fn().mockReturnValue(vi.fn())
    }
    const provider = new SshPtyProvider('conn-1', mux as never)

    const rejection = await provider.spawn({ cols: 80, rows: 24, sessionId: 'pty-old' }).then(
      () => undefined,
      (error: unknown) => error
    )
    expect(rejection).toBeInstanceOf(Error)
    expect((rejection as Error).message).toBe(`${SSH_SOURCE_RESTORE_REQUIRED_ERROR}: pty-old`)
    expect((rejection as Error).message).not.toContain(SSH_SESSION_EXPIRED_ERROR)
    expect(mux.request).toHaveBeenCalledTimes(3)
  })
})
