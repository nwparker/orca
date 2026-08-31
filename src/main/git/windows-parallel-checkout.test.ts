import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

import { clearGitCapabilityStateForTests } from './git-capability-state'
import { resolveLocalWindowsParallelCheckoutGitArgs } from './windows-parallel-checkout'
import {
  resetWslLinkedWorktreeGitRoutingForTests,
  seedWslLinkedWorktreeGitRoutingForTests
} from './wsl-linked-worktree-git-routing'

describe('resolveLocalWindowsParallelCheckoutGitArgs', () => {
  beforeEach(() => {
    clearGitCapabilityStateForTests()
    resetWslLinkedWorktreeGitRoutingForTests()
    gitExecFileAsyncMock.mockReset()
  })

  it('probes an existing repository instead of a not-yet-created target', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git version 2.55.0.windows.3\n',
      stderr: ''
    })

    await expect(
      resolveLocalWindowsParallelCheckoutGitArgs('C:\\repo-feature', {
        platform: 'win32',
        probeCwd: 'C:\\repo',
        timeout: 180_000
      })
    ).resolves.toEqual(['-c', 'checkout.workers=-1'])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['--version'],
      expect.objectContaining({ cwd: 'C:\\repo', timeout: 5_000 })
    )
  })

  it('keeps the FSCache workaround for an old native Git host', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git version 2.54.0.windows.1\n',
      stderr: ''
    })

    await expect(
      resolveLocalWindowsParallelCheckoutGitArgs('C:\\repo-feature', {
        platform: 'win32',
        probeCwd: 'C:\\repo'
      })
    ).resolves.toEqual(['-c', 'core.fscache=false', '-c', 'checkout.workers=-1'])
  })

  it('treats a non-WSL UNC share as a native Windows Git host', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git version 2.55.0.windows.3\n',
      stderr: ''
    })

    await expect(
      resolveLocalWindowsParallelCheckoutGitArgs('\\\\server\\share\\repo-feature', {
        platform: 'win32',
        probeCwd: '\\\\server\\share\\repo'
      })
    ).resolves.toEqual(['-c', 'checkout.workers=-1'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['--version'],
      expect.objectContaining({ cwd: '\\\\server\\share\\repo' })
    )
  })

  it('probes host Git for a Windows-linked worktree despite a WSL override', async () => {
    seedWslLinkedWorktreeGitRoutingForTests('C:\\linked')
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'git version 2.55.0.windows.3\n',
      stderr: ''
    })

    await expect(
      resolveLocalWindowsParallelCheckoutGitArgs('C:\\linked', {
        platform: 'win32',
        wslDistro: 'Ubuntu',
        probeCwd: 'C:\\repo'
      })
    ).resolves.toEqual(['-c', 'checkout.workers=-1'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['--version'],
      expect.objectContaining({ cwd: 'C:\\repo' })
    )
    expect(gitExecFileAsyncMock.mock.calls[0]?.[1]).not.toHaveProperty('wslDistro')
  })

  it('keeps the default worker policy for a WSL ext4 worktree', async () => {
    await expect(
      resolveLocalWindowsParallelCheckoutGitArgs('\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', {
        platform: 'win32',
        wslDistro: 'Ubuntu'
      })
    ).resolves.toEqual([])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('uses the all-worker pool for a WSL DrvFS worktree', async () => {
    await expect(
      resolveLocalWindowsParallelCheckoutGitArgs('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\repo', {
        platform: 'win32',
        wslDistro: 'Ubuntu'
      })
    ).resolves.toEqual(['-c', 'checkout.workers=-1'])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps the default worker policy for an explicitly WSL-routed ext4 worktree', async () => {
    await expect(
      resolveLocalWindowsParallelCheckoutGitArgs('/home/dev/repo', {
        platform: 'win32',
        wslDistro: 'Ubuntu'
      })
    ).resolves.toEqual([])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('uses the all-worker pool for an explicitly WSL-routed DrvFS path', async () => {
    await expect(
      resolveLocalWindowsParallelCheckoutGitArgs('/mnt/c/repo', {
        platform: 'win32',
        wslDistro: 'Ubuntu'
      })
    ).resolves.toEqual(['-c', 'checkout.workers=-1'])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
