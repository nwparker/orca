import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { resolveWorktreeAddBaseRef } from '../../shared/worktree/base-ref'
import type { AddWorktreeOptions, AddWorktreeResult, GitWorktreeExecOptions } from './worktree'
import {
  configurePushAutoSetupRemote,
  notifyPreparedWorktreeMutation,
  persistWorktreeCreationBase,
  resolveWorktreeAddBaseContext,
  resolveWorktreeAddTimeoutMs
} from './worktree'
import { hasWorktreeBaseCommitRef } from './worktree-base-ref-probe'
import { gitExecFileAsync } from './runner'
import { resolveLocalWindowsParallelCheckoutGitArgs } from './windows-parallel-checkout'
import {
  gitExecOptions,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
} from './worktree-operation-options'
import {
  gitCleanupOptions,
  performDiscardPreparedWorktree,
  removeFailedFinalization
} from './worktree-create-preparation-cleanup'
import {
  invalidateWslLinkedWorktreeGitRouting,
  isWslLinkedWorktreeGitRoutingCandidate
} from './wsl-linked-worktree-git-routing'
import { runWithGitReadCacheInvalidation } from './status'

export async function prepareWorktreeCreateCheckout(
  repoPath: string,
  worktreePath: string,
  baseBranch: string,
  lockReason: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  try {
    await runWithGitReadCacheInvalidation(async () => {
      const parallelCheckoutArgsPromise = resolveLocalWindowsParallelCheckoutGitArgs(worktreePath, {
        ...options,
        probeCwd: repoPath
      })
      // Base validation can fail before reset; observe the speculative probe so
      // cancellation/failure never becomes an unhandled rejection.
      void parallelCheckoutArgsPromise.catch(() => {})
      const effectiveBase = await resolveWorktreeAddBaseRef(baseBranch, (qualifiedRef) =>
        hasWorktreeBaseCommitRef(repoPath, qualifiedRef, options)
      )
      try {
        await gitExecFileAsync(
          [
            ...windowsLongPathGitArgs(repoPath),
            'worktree',
            'add',
            '--detach',
            '--no-checkout',
            worktreePath,
            effectiveBase
          ],
          { ...gitExecOptions(repoPath, options), timeout: resolveWorktreeAddTimeoutMs() }
        )
        // The add just created the marker; clear any speculative miss/backoff
        // before routing the materializing reset.
        invalidateWslLinkedWorktreeGitRouting(worktreePath)
        // Why: reset materializes files without running user post-checkout hooks before submit.
        const checkoutArgs = isWslLinkedWorktreeGitRoutingCandidate(worktreePath, options.wslDistro)
          ? await resolveLocalWindowsParallelCheckoutGitArgs(worktreePath, {
              ...options,
              probeCwd: repoPath
            })
          : await parallelCheckoutArgsPromise
        await gitExecFileAsync(
          [
            ...windowsLongPathGitArgs(worktreePath),
            ...checkoutArgs,
            'reset',
            '--hard',
            effectiveBase
          ],
          { ...gitExecOptions(worktreePath, options), timeout: resolveWorktreeAddTimeoutMs() }
        )
        await gitExecFileAsync(
          [
            ...windowsLongPathGitArgs(repoPath),
            'worktree',
            'lock',
            '--reason',
            lockReason,
            worktreePath
          ],
          { ...gitExecOptions(repoPath, options), timeout: resolveWorktreeAddTimeoutMs() }
        )
      } catch (error) {
        await performDiscardPreparedWorktree(repoPath, worktreePath, options).catch(() => {})
        throw error
      }
    })
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}

export async function discardPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  try {
    await runWithGitReadCacheInvalidation(() =>
      performDiscardPreparedWorktree(repoPath, worktreePath, options)
    )
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}

export async function unlockPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {}
): Promise<void> {
  const cleanupGitOptions = {
    ...gitCleanupOptions(repoPath, options),
    timeout: options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  }
  try {
    await runWithGitReadCacheInvalidation(() =>
      gitExecFileAsync(
        [...windowsLongPathGitArgs(repoPath), 'worktree', 'unlock', worktreePath],
        cleanupGitOptions
      )
    )
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}

export async function finalizePreparedWorktree(
  repoPath: string,
  preparedPath: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
  refreshLocalBaseRef = false,
  options: AddWorktreeOptions = {}
): Promise<AddWorktreeResult> {
  const finalizeGitOptions: AddWorktreeOptions = {
    ...options,
    timeout: options.timeout ?? resolveWorktreeAddTimeoutMs()
  }
  try {
    return await runWithGitReadCacheInvalidation(async () => {
      const preparedParallelCheckoutArgsPromise = resolveLocalWindowsParallelCheckoutGitArgs(
        preparedPath,
        {
          ...finalizeGitOptions,
          probeCwd: repoPath
        }
      )
      void preparedParallelCheckoutArgsPromise.catch(() => {})
      const baseContext = await resolveWorktreeAddBaseContext(
        repoPath,
        baseBranch,
        refreshLocalBaseRef,
        finalizeGitOptions
      )
      const [targetHeadResult, preparedHeadResult] = await Promise.all([
        gitExecFileAsync(
          ['rev-parse', '--verify', `${baseContext.effectiveBase}^{commit}`],
          gitExecOptions(repoPath, finalizeGitOptions)
        ),
        gitExecFileAsync(
          ['rev-parse', '--verify', 'HEAD'],
          gitExecOptions(preparedPath, finalizeGitOptions)
        )
      ])
      const targetHead = targetHeadResult.stdout.trim()
      if (preparedHeadResult.stdout.trim() !== targetHead) {
        const preparedParallelCheckoutArgs = await preparedParallelCheckoutArgsPromise
        await gitExecFileAsync(
          [
            ...windowsLongPathGitArgs(preparedPath),
            ...preparedParallelCheckoutArgs,
            'reset',
            '--hard',
            targetHead
          ],
          gitExecOptions(preparedPath, finalizeGitOptions)
        )
      }

      let moved = false
      try {
        await gitExecFileAsync(
          [
            ...windowsLongPathGitArgs(repoPath),
            'worktree',
            'move',
            '-f',
            '-f',
            preparedPath,
            worktreePath
          ],
          gitExecOptions(repoPath, finalizeGitOptions)
        )
        moved = true
        invalidateWslLinkedWorktreeGitRouting(preparedPath)
        invalidateWslLinkedWorktreeGitRouting(worktreePath)
        // Resolve after the move so a newly-created `.git` marker can select
        // the correct WSL/host route for the final checkout.
        const targetParallelCheckoutArgs = await resolveLocalWindowsParallelCheckoutGitArgs(
          worktreePath,
          {
            ...finalizeGitOptions,
            probeCwd: repoPath
          }
        )
        // Why: `-f -f` moves the locked preparation while preserving its lock reason (Git >=2.25).
        await gitExecFileAsync(
          [
            ...windowsLongPathGitArgs(worktreePath),
            ...targetParallelCheckoutArgs,
            'checkout',
            '--no-track',
            '-b',
            branch,
            targetHead
          ],
          gitExecOptions(worktreePath, finalizeGitOptions)
        )
        await persistWorktreeCreationBase(
          worktreePath,
          branch,
          baseContext.effectiveBase,
          finalizeGitOptions
        )
        await configurePushAutoSetupRemote(worktreePath, finalizeGitOptions)
        await gitExecFileAsync(
          [...windowsLongPathGitArgs(repoPath), 'worktree', 'unlock', worktreePath],
          gitExecOptions(repoPath, finalizeGitOptions)
        )
      } catch (error) {
        // A failed move may have changed one marker before returning an error;
        // clear both route keys before best-effort rollback probes them.
        invalidateWslLinkedWorktreeGitRouting(preparedPath)
        invalidateWslLinkedWorktreeGitRouting(worktreePath)
        await removeFailedFinalization(
          repoPath,
          moved ? worktreePath : preparedPath,
          branch,
          moved,
          finalizeGitOptions
        )
        throw error
      }
      return {
        ...(baseContext.localBaseRefRefresh
          ? { localBaseRefRefresh: baseContext.localBaseRefRefresh }
          : {}),
        ...(baseContext.localBaseRefUpdateSuggestion
          ? { localBaseRefUpdateSuggestion: baseContext.localBaseRefUpdateSuggestion }
          : {})
      }
    })
  } finally {
    notifyPreparedWorktreeMutation(repoPath)
  }
}
