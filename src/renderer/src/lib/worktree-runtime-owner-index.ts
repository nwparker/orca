import type { Repo, Worktree } from '../../../shared/types'

export type RuntimeOwnerWorktreeRecord = Pick<Worktree, 'id' | 'repoId' | 'hostId'>
export type RuntimeOwnerRepoRecord = Pick<Repo, 'id' | 'connectionId' | 'executionHostId'>
export type RuntimeOwnerWorktreesByRepo = Record<string, readonly RuntimeOwnerWorktreeRecord[]>

// Why: Zustand reruns owner selectors on every store write. Cache only the current
// immutable slice references so repeated lookups are O(1) without retaining history.
let indexedWorktreesByRepo: RuntimeOwnerWorktreesByRepo | null = null
let worktreeById = new Map<string, RuntimeOwnerWorktreeRecord>()
let indexedRepos: readonly RuntimeOwnerRepoRecord[] | null = null
let repoById = new Map<string, RuntimeOwnerRepoRecord>()

export function findRuntimeOwnerWorktreeById(
  worktreesByRepo: RuntimeOwnerWorktreesByRepo | undefined,
  worktreeId: string
): RuntimeOwnerWorktreeRecord | null {
  if (!worktreesByRepo) {
    return null
  }
  if (indexedWorktreesByRepo !== worktreesByRepo) {
    const next = new Map<string, RuntimeOwnerWorktreeRecord>()
    for (const worktrees of Object.values(worktreesByRepo)) {
      for (const worktree of worktrees) {
        const id = worktree.id
        if (!next.has(id)) {
          next.set(id, worktree)
        }
      }
    }
    indexedWorktreesByRepo = worktreesByRepo
    worktreeById = next
  }
  return worktreeById.get(worktreeId) ?? null
}

export function findRuntimeOwnerRepoById(
  repos: readonly RuntimeOwnerRepoRecord[] | undefined,
  repoId: string
): RuntimeOwnerRepoRecord | null {
  if (!repos) {
    return null
  }
  if (indexedRepos !== repos) {
    const next = new Map<string, RuntimeOwnerRepoRecord>()
    for (const repo of repos) {
      const id = repo.id
      if (!next.has(id)) {
        next.set(id, repo)
      }
    }
    indexedRepos = repos
    repoById = next
  }
  return repoById.get(repoId) ?? null
}
