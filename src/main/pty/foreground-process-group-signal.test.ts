import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileSyncMock } = vi.hoisted(() => ({
  execFileSyncMock: vi.fn()
}))

vi.mock('child_process', () => ({
  execFileSync: execFileSyncMock
}))

import { signalForegroundProcessGroup } from './foreground-process-group-signal'

describe('signalForegroundProcessGroup', () => {
  let killSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    execFileSyncMock.mockReset()
    killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true)
  })

  afterEach(() => {
    killSpy.mockRestore()
  })

  it('signals the POSIX terminal foreground process group', () => {
    if (process.platform === 'win32') {
      expect(signalForegroundProcessGroup(123, 'SIGWINCH')).toBe(false)
      expect(execFileSyncMock).not.toHaveBeenCalled()
      return
    }

    execFileSyncMock.mockReturnValue(' 4321\n')

    expect(signalForegroundProcessGroup(123, 'SIGWINCH')).toBe(true)
    expect(execFileSyncMock).toHaveBeenCalledWith('ps', ['-o', 'tpgid=', '-p', '123'], {
      encoding: 'utf8',
      timeout: 1000
    })
    expect(killSpy).toHaveBeenCalledWith(-4321, 'SIGWINCH')
  })

  it('returns false when the foreground group cannot be resolved', () => {
    execFileSyncMock.mockReturnValue('not-a-pid\n')

    expect(signalForegroundProcessGroup(123, 'SIGWINCH')).toBe(false)
    expect(killSpy).not.toHaveBeenCalled()
  })
})
