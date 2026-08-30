import { isFolderRepo } from '../shared/repo-kind'
import type { Repo } from '../shared/repo-types'
import { hasCommitObjectViaGitExec, isFullGitObjectId } from './git/commit-object-ref'
import { hasWorktreeBaseCommitRef } from './git/worktree-base-ref-probe'
import { getBaseRefDefault } from './git/repo'
import { gitExecFileAsync } from './git/runner'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { prefetchRemoteWorktreeCreateBase } from './ipc/worktree-remote'
import { resolveWorktreeCreateBase } from './worktree-create-base'
import { resolveWorktreeAddBaseRef } from '../shared/worktree/base-ref'

type WorktreeCreateBaseGitOptions = {
  wslDistro?: string
}

type RemoteTrackingBaseForPrefetch = {
  remote: string
  branch: string
  ref: string
  base: string
}

type WorktreeCreateBasePrefetchRuntime = {
  resolveRemoteTrackingBase: (
    repoPath: string,
    baseBranch: string,
    options?: WorktreeCreateBaseGitOptions
  ) => Promise<RemoteTrackingBaseForPrefetch | null>
  hasRemoteTrackingRef: (
    repoPath: string,
    base: RemoteTrackingBaseForPrefetch,
    options?: WorktreeCreateBaseGitOptions
  ) => Promise<boolean>
  getOrStartRemoteTrackingBaseRefresh: (
    repoPath: string,
    base: RemoteTrackingBaseForPrefetch,
    options?: WorktreeCreateBaseGitOptions
  ) => Promise<unknown>
  fetchRemoteWithCache: (
    repoPath: string,
    remote: string,
    options?: WorktreeCreateBaseGitOptions
  ) => Promise<void>
}

async function hasLocalWorktreeBaseRef(
  repoPath: string,
  baseRef: string,
  options: WorktreeCreateBaseGitOptions
): Promise<boolean> {
  const refExists = (qualifiedRef: string) =>
    hasWorktreeBaseCommitRef(repoPath, qualifiedRef, options)
  const resolvedBaseRef = await resolveWorktreeAddBaseRef(baseRef, refExists)
  if (resolvedBaseRef !== baseRef) {
    return true
  }
  if (baseRef.startsWith('refs/')) {
    return refExists(baseRef)
  }
  return hasCommitObjectViaGitExec(
    (args) => gitExecFileAsync(args, { cwd: repoPath, ...options }),
    baseRef
  )
}

async function prefetchLocalWorktreeCreateBase(
  repo: Repo,
  baseBranch: string | undefined,
  runtime: WorktreeCreateBasePrefetchRuntime,
  options: WorktreeCreateBaseGitOptions
): Promise<string | undefined> {
  const optionArgs: [] | [WorktreeCreateBaseGitOptions] = options.wslDistro ? [options] : []
  const resolvedBaseBranch = await resolveWorktreeCreateBase({
    requestedBaseBranch: baseBranch,
    repoWorktreeBaseRef: repo.worktreeBaseRef,
    resolveDefaultBaseRef: () => getBaseRefDefault(repo.path, ...optionArgs),
    isBaseUsable: async (baseBranchCandidate) => {
      const remoteTrackingBase = await runtime.resolveRemoteTrackingBase(
        repo.path,
        baseBranchCandidate,
        ...optionArgs
      )
      if (remoteTrackingBase) {
        if (await runtime.hasRemoteTrackingRef(repo.path, remoteTrackingBase, ...optionArgs)) {
          return true
        }
        return hasLocalWorktreeBaseRef(repo.path, baseBranchCandidate, options)
      }
      return hasLocalWorktreeBaseRef(repo.path, baseBranchCandidate, options)
    }
  })
  if (!resolvedBaseBranch) {
    return undefined
  }
  if (
    isFullGitObjectId(resolvedBaseBranch) &&
    (await hasLocalWorktreeBaseRef(repo.path, resolvedBaseBranch, options))
  ) {
    return resolvedBaseBranch
  }
  const remoteTrackingBase = await runtime.resolveRemoteTrackingBase(
    repo.path,
    resolvedBaseBranch,
    ...optionArgs
  )
  if (remoteTrackingBase) {
    if (
      (await runtime.hasRemoteTrackingRef(repo.path, remoteTrackingBase, ...optionArgs)) ||
      !(await hasLocalWorktreeBaseRef(repo.path, resolvedBaseBranch, options))
    ) {
      await runtime.getOrStartRemoteTrackingBaseRefresh(
        repo.path,
        remoteTrackingBase,
        ...optionArgs
      )
      return resolvedBaseBranch
    }
  }
  if (await hasLocalWorktreeBaseRef(repo.path, resolvedBaseBranch, options)) {
    // Why: hosted-review start points and local branch bases are already local; a broad remote fetch cannot make them fresher.
    return resolvedBaseBranch
  }

  // Why: keep optimistic prefetch on the same best-effort fallback path as
  // create so the real create can reuse the runtime's remote fetch cache.
  await runtime.fetchRemoteWithCache(repo.path, 'origin', ...optionArgs)
  return resolvedBaseBranch
}

export async function prefetchWorktreeCreateBase(args: {
  repo: Repo
  baseBranch?: string
  runtime: WorktreeCreateBasePrefetchRuntime
  gitOptions?: WorktreeCreateBaseGitOptions
}): Promise<string | undefined> {
  if (isFolderRepo(args.repo)) {
    return undefined
  }
  if (args.repo.connectionId) {
    const provider = getSshGitProvider(args.repo.connectionId)
    if (!provider) {
      return undefined
    }
    await prefetchRemoteWorktreeCreateBase(provider, args.repo, { baseBranch: args.baseBranch })
    return undefined
  }
  return prefetchLocalWorktreeCreateBase(
    args.repo,
    args.baseBranch,
    args.runtime,
    args.gitOptions ?? {}
  )
}
