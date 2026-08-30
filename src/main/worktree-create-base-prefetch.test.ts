import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getBaseRefDefault: vi.fn(),
  hasWorktreeBaseCommitRef: vi.fn(),
  gitExecFileAsync: vi.fn(),
  getSshGitProvider: vi.fn(),
  prefetchRemoteWorktreeCreateBase: vi.fn(),
  resolveRemoteTrackingBase: vi.fn(),
  hasRemoteTrackingRef: vi.fn(),
  getOrStartRemoteTrackingBaseRefresh: vi.fn(),
  fetchRemoteWithCache: vi.fn()
}))

vi.mock('./git/repo', () => ({ getBaseRefDefault: mocks.getBaseRefDefault }))
vi.mock('./git/worktree-base-ref-probe', () => ({
  hasWorktreeBaseCommitRef: mocks.hasWorktreeBaseCommitRef
}))
vi.mock('./git/runner', () => ({ gitExecFileAsync: mocks.gitExecFileAsync }))
vi.mock('./providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getSshGitProvider
}))
vi.mock('./ipc/worktree-remote', () => ({
  prefetchRemoteWorktreeCreateBase: mocks.prefetchRemoteWorktreeCreateBase
}))

import { prefetchWorktreeCreateBase } from './worktree-create-base-prefetch'

const repo = {
  id: 'repo-1',
  path: String.raw`C:\workspace\repo`,
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0,
  kind: 'git' as const,
  worktreeBaseRef: undefined
}

function runtime() {
  return {
    resolveRemoteTrackingBase: mocks.resolveRemoteTrackingBase,
    hasRemoteTrackingRef: mocks.hasRemoteTrackingRef,
    getOrStartRemoteTrackingBaseRefresh: mocks.getOrStartRemoteTrackingBaseRefresh,
    fetchRemoteWithCache: mocks.fetchRemoteWithCache
  }
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.getBaseRefDefault.mockResolvedValue('origin/main')
  mocks.hasWorktreeBaseCommitRef.mockResolvedValue(false)
  mocks.gitExecFileAsync.mockResolvedValue({ stdout: '', stderr: '' })
  mocks.resolveRemoteTrackingBase.mockResolvedValue(null)
  mocks.hasRemoteTrackingRef.mockResolvedValue(false)
  mocks.getOrStartRemoteTrackingBaseRefresh.mockResolvedValue({ ok: true })
  mocks.fetchRemoteWithCache.mockResolvedValue(undefined)
})

describe('prefetchWorktreeCreateBase local Git routing', () => {
  it('routes default and named-ref probes through the selected WSL distro', async () => {
    mocks.hasWorktreeBaseCommitRef.mockImplementation(
      async (_repoPath: string, ref: string) => ref === 'refs/remotes/origin/main'
    )

    await expect(
      prefetchWorktreeCreateBase({
        repo,
        runtime: runtime(),
        gitOptions: { wslDistro: 'Ubuntu' }
      })
    ).resolves.toBe('origin/main')

    expect(mocks.getBaseRefDefault).toHaveBeenCalledWith(repo.path, { wslDistro: 'Ubuntu' })
    expect(mocks.resolveRemoteTrackingBase).toHaveBeenCalledWith(repo.path, 'origin/main', {
      wslDistro: 'Ubuntu'
    })
    expect(mocks.hasWorktreeBaseCommitRef).toHaveBeenCalledWith(
      repo.path,
      'refs/remotes/origin/main',
      { wslDistro: 'Ubuntu' }
    )
  })

  it('routes full commit-object probes through the selected WSL distro', async () => {
    const sha = 'a'.repeat(40)

    await expect(
      prefetchWorktreeCreateBase({
        repo,
        baseBranch: sha,
        runtime: runtime(),
        gitOptions: { wslDistro: 'Ubuntu' }
      })
    ).resolves.toBe(sha)

    expect(mocks.gitExecFileAsync).toHaveBeenCalledWith(
      ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`],
      { cwd: repo.path, wslDistro: 'Ubuntu' }
    )
  })

  it('routes exact remote-base refreshes through the selected WSL distro', async () => {
    const remoteBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    mocks.resolveRemoteTrackingBase.mockResolvedValue(remoteBase)

    await expect(
      prefetchWorktreeCreateBase({
        repo,
        baseBranch: 'origin/main',
        runtime: runtime(),
        gitOptions: { wslDistro: 'Ubuntu' }
      })
    ).resolves.toBe('origin/main')

    expect(mocks.hasRemoteTrackingRef).toHaveBeenCalledWith(repo.path, remoteBase, {
      wslDistro: 'Ubuntu'
    })
    expect(mocks.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledWith(repo.path, remoteBase, {
      wslDistro: 'Ubuntu'
    })
  })

  it('routes broad remote-fetch fallback through the selected WSL distro', async () => {
    await expect(
      prefetchWorktreeCreateBase({
        repo,
        baseBranch: 'feature/topic',
        runtime: runtime(),
        gitOptions: { wslDistro: 'Ubuntu' }
      })
    ).resolves.toBe('feature/topic')

    expect(mocks.fetchRemoteWithCache).toHaveBeenCalledWith(repo.path, 'origin', {
      wslDistro: 'Ubuntu'
    })
  })
})
