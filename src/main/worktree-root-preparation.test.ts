import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../shared/repo-types'
import * as worktreeLogic from './ipc/worktree-logic'

const { mkdirMock, authorizeExternalPathMock } = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  authorizeExternalPathMock: vi.fn()
}))

vi.mock('fs/promises', () => ({
  mkdir: mkdirMock
}))

vi.mock('./ipc/filesystem-auth', () => ({
  authorizeExternalPath: authorizeExternalPathMock
}))

import { prepareLocalWorktreeRootForRepo } from './worktree-root-preparation'

const repo: Repo = {
  id: 'repo-1',
  path: '/projects/app',
  displayName: 'app',
  badgeColor: '#000',
  addedAt: 1,
  kind: 'git'
}

const store = {
  getSettings: vi.fn()
}

describe('prepareLocalWorktreeRootForRepo', () => {
  beforeEach(() => {
    mkdirMock.mockReset().mockResolvedValue(undefined)
    authorizeExternalPathMock.mockReset()
    vi.restoreAllMocks()
    store.getSettings.mockReset().mockReturnValue({
      workspaceDir: '/Users/alice/orca/workspaces',
      nestWorkspaces: false
    })
  })

  it('creates the effective worktree root for local git repos', async () => {
    await prepareLocalWorktreeRootForRepo(store as never, repo)

    expect(mkdirMock).toHaveBeenCalledWith('/Users/alice/orca/workspaces', { recursive: true })
  })

  it('resolves the root asynchronously without invoking the synchronous WSL probe', async () => {
    let resolveRoot!: (root: string) => void
    const rootReady = new Promise<string>((resolve) => {
      resolveRoot = resolve
    })
    const asyncRootSpy = vi
      .spyOn(worktreeLogic, 'computeWorkspaceRootAsync')
      .mockReturnValue(rootReady)
    const syncRootSpy = vi.spyOn(worktreeLogic, 'computeWorkspaceRoot').mockImplementation(() => {
      throw new Error('synchronous workspace-root lookup must not run')
    })

    const preparation = prepareLocalWorktreeRootForRepo(store as never, repo)
    await Promise.resolve()
    expect(mkdirMock).not.toHaveBeenCalled()

    resolveRoot('/async-workspaces')
    await preparation

    expect(asyncRootSpy).toHaveBeenCalledTimes(1)
    expect(syncRootSpy).not.toHaveBeenCalled()
    expect(mkdirMock).toHaveBeenCalledWith('/async-workspaces', { recursive: true })
  })

  it('uses repo-specific worktree base paths', async () => {
    await prepareLocalWorktreeRootForRepo(store as never, {
      ...repo,
      worktreeBasePath: '../worktrees'
    })

    expect(mkdirMock).toHaveBeenCalledWith('/projects/worktrees', { recursive: true })
  })

  it('skips non-local and folder repos', async () => {
    await prepareLocalWorktreeRootForRepo(store as never, { ...repo, connectionId: 'ssh-1' })
    await prepareLocalWorktreeRootForRepo(store as never, {
      ...repo,
      executionHostId: 'ssh:ssh-1'
    })
    await prepareLocalWorktreeRootForRepo(store as never, {
      ...repo,
      executionHostId: 'runtime:env-1'
    })
    await prepareLocalWorktreeRootForRepo(store as never, { ...repo, kind: 'folder' })

    expect(mkdirMock).not.toHaveBeenCalled()
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
  })

  it('does not fail repo setup when root preparation fails', async () => {
    mkdirMock.mockRejectedValueOnce(new Error('permission denied'))

    await expect(prepareLocalWorktreeRootForRepo(store as never, repo)).resolves.toBeUndefined()
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
  })
})
