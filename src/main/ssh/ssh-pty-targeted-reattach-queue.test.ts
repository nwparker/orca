import { describe, expect, it, vi } from 'vitest'
import {
  SSH_PTY_REATTACH_CANCELLED,
  SshPtyTargetedReattachQueue
} from './ssh-pty-targeted-reattach-queue'

function deferredBoolean(): {
  promise: Promise<boolean>
  resolve: (value: boolean) => void
} {
  let resolve!: (value: boolean) => void
  const promise = new Promise<boolean>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

describe('SshPtyTargetedReattachQueue', () => {
  it('settles cleared waiters without resetting active work accounting', async () => {
    const queue = new SshPtyTargetedReattachQueue(1)
    const oldGate = deferredBoolean()
    const replacementGate = deferredBoolean()
    const oldTask = vi.fn(() => oldGate.promise)
    const clearedTask = vi.fn().mockResolvedValue(true)
    const replacementTask = vi.fn(() => replacementGate.promise)

    const oldRun = queue.run('pty-1', oldTask)
    const clearedRun = queue.run('pty-2', clearedTask)
    queue.clear()

    await expect(clearedRun).resolves.toBe(SSH_PTY_REATTACH_CANCELLED)
    expect(clearedTask).not.toHaveBeenCalled()

    const replacementRun = queue.run('pty-1', replacementTask)
    expect(replacementTask).not.toHaveBeenCalled()

    oldGate.resolve(false)
    await expect(oldRun).resolves.toBe(false)
    expect(replacementTask).toHaveBeenCalledOnce()
    expect(queue.has('pty-1')).toBe(true)

    replacementGate.resolve(true)
    await expect(replacementRun).resolves.toBe(true)
    expect(queue.has('pty-1')).toBe(false)
  })
})
