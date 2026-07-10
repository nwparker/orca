import { describe, expect, it } from 'vitest'
import {
  findRuntimeOwnerRepoById,
  findRuntimeOwnerWorktreeById,
  type RuntimeOwnerRepoRecord,
  type RuntimeOwnerWorktreesByRepo
} from './worktree-runtime-owner-index'

describe('runtime owner indexes', () => {
  it('reuses indexes while slice references are unchanged', () => {
    let worktreeIdReads = 0
    let repoIdReads = 0
    const repos: RuntimeOwnerRepoRecord[] = Array.from({ length: 3 }, (_, index) => {
      const id = `repo-${index}`
      const repo: RuntimeOwnerRepoRecord = {
        id,
        connectionId: null,
        executionHostId: `runtime:env-${index}`
      }
      Object.defineProperty(repo, 'id', {
        enumerable: true,
        get: () => ((repoIdReads += 1), id)
      })
      return repo
    })
    const worktreesByRepo: RuntimeOwnerWorktreesByRepo = Object.fromEntries(
      repos.map((repo, index) => {
        const id = `${repo.id}::wt-${index}`
        const worktree = { id, repoId: repo.id }
        Object.defineProperty(worktree, 'id', {
          enumerable: true,
          get: () => ((worktreeIdReads += 1), id)
        })
        return [repo.id, [worktree]]
      })
    )
    repoIdReads = 0

    expect(findRuntimeOwnerWorktreeById(worktreesByRepo, 'repo-2::wt-2')?.repoId).toBe('repo-2')
    expect(findRuntimeOwnerRepoById(repos, 'repo-2')?.executionHostId).toBe('runtime:env-2')
    expect(findRuntimeOwnerWorktreeById(worktreesByRepo, 'repo-1::wt-1')?.repoId).toBe('repo-1')
    expect(findRuntimeOwnerRepoById(repos, 'repo-1')?.executionHostId).toBe('runtime:env-1')
    expect(worktreeIdReads).toBe(3)
    expect(repoIdReads).toBe(3)
  })

  it('preserves first-match behavior for duplicate ids', () => {
    const firstRepo: RuntimeOwnerRepoRecord = { id: 'duplicate' }
    const secondRepo: RuntimeOwnerRepoRecord = { id: 'duplicate', connectionId: 'second' }
    const worktreesByRepo: RuntimeOwnerWorktreesByRepo = {
      first: [{ id: 'duplicate', repoId: 'first' }],
      second: [{ id: 'duplicate', repoId: 'second' }]
    }

    expect(findRuntimeOwnerWorktreeById(worktreesByRepo, 'duplicate')?.repoId).toBe('first')
    expect(findRuntimeOwnerRepoById([firstRepo, secondRepo], 'duplicate')).toBe(firstRepo)
  })

  it('rebuilds indexes when immutable slice references change', () => {
    const firstRepos: RuntimeOwnerRepoRecord[] = [{ id: 'repo', executionHostId: 'runtime:first' }]
    const secondRepos: RuntimeOwnerRepoRecord[] = [
      { id: 'repo', executionHostId: 'runtime:second' }
    ]
    const firstWorktrees: RuntimeOwnerWorktreesByRepo = {
      repo: [{ id: 'worktree', repoId: 'first' }]
    }
    const secondWorktrees: RuntimeOwnerWorktreesByRepo = {
      repo: [{ id: 'worktree', repoId: 'second' }]
    }

    expect(findRuntimeOwnerRepoById(firstRepos, 'repo')?.executionHostId).toBe('runtime:first')
    expect(findRuntimeOwnerRepoById(secondRepos, 'repo')?.executionHostId).toBe('runtime:second')
    expect(findRuntimeOwnerWorktreeById(firstWorktrees, 'worktree')?.repoId).toBe('first')
    expect(findRuntimeOwnerWorktreeById(secondWorktrees, 'worktree')?.repoId).toBe('second')
  })
})
