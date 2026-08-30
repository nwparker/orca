import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  prefetchWorktreeCreateBase: vi.fn(),
  prepareWorktreeCreateForRepo: vi.fn(),
  getLocalProjectWorktreeGitOptions: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../../worktree-create-base-prefetch', () => ({
  prefetchWorktreeCreateBase: mocks.prefetchWorktreeCreateBase
}))
vi.mock('../../../worktree-create-preparation', () => ({
  prepareWorktreeCreateForRepo: mocks.prepareWorktreeCreateForRepo
}))
vi.mock('../../../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: mocks.getLocalProjectWorktreeGitOptions
}))

import { registerWorktreePrefetchHandler } from './register-worktree-prefetch-handler'

type PrefetchHandler = (
  event: unknown,
  args: { repoId: string; baseBranch?: string }
) => Promise<void>

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.getLocalProjectWorktreeGitOptions.mockReturnValue({})
  mocks.prefetchWorktreeCreateBase.mockResolvedValue(undefined)
  mocks.prepareWorktreeCreateForRepo.mockResolvedValue(undefined)
})

describe('registerWorktreePrefetchHandler', () => {
  it('passes the project WSL runtime to speculative prefetch and preparation', async () => {
    let handler: PrefetchHandler | undefined
    mocks.handle.mockImplementation((_channel: unknown, callback: unknown) => {
      handler = callback as PrefetchHandler
    })
    const repo = { id: 'repo-1', path: String.raw`C:\repo` }
    const store = { getRepo: vi.fn().mockReturnValue(repo) }
    const runtime = {}
    const gitOptions = { wslDistro: 'Ubuntu' }
    mocks.getLocalProjectWorktreeGitOptions.mockReturnValue(gitOptions)
    mocks.prefetchWorktreeCreateBase.mockResolvedValue('origin/main')

    registerWorktreePrefetchHandler({ store, runtime } as never)
    await handler?.(null, { repoId: 'repo-1', baseBranch: 'origin/main' })

    expect(mocks.getLocalProjectWorktreeGitOptions).toHaveBeenCalledWith(store, repo)
    expect(mocks.prefetchWorktreeCreateBase).toHaveBeenCalledWith({
      repo,
      baseBranch: 'origin/main',
      runtime,
      gitOptions
    })
    expect(mocks.prepareWorktreeCreateForRepo).toHaveBeenCalledWith(store, repo, 'origin/main')
  })
})
