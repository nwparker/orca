import { windowsLongPathGitArgs } from '../../shared/windows-long-path-git-args'
import { gitExecFileAsync } from './runner'
import { invalidateWslLinkedWorktreeGitRouting } from './wsl-linked-worktree-git-routing'
import {
  gitExecOptions,
  type GitWorktreeExecOptions,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
} from './worktree-operation-options'

export function gitCleanupOptions(
  cwd: string,
  options: GitWorktreeExecOptions
): { cwd: string; wslDistro?: string; timeout?: number } {
  // Cancellation must not strand a partially moved worktree; cleanup is bounded separately.
  return gitExecOptions(cwd, { ...options, signal: undefined })
}

export async function performDiscardPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions
): Promise<void> {
  const cleanupGitOptions = {
    ...gitCleanupOptions(repoPath, options),
    timeout: options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS
  }
  try {
    await gitExecFileAsync(
      [...windowsLongPathGitArgs(repoPath), 'worktree', 'unlock', worktreePath],
      cleanupGitOptions
    )
  } catch {
    // It may be unlocked already or only partially registered.
  }
  try {
    await gitExecFileAsync(
      [...windowsLongPathGitArgs(repoPath), 'worktree', 'remove', '--force', worktreePath],
      cleanupGitOptions
    )
  } finally {
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
  }
}

export async function removeFailedFinalization(
  repoPath: string,
  cleanupPath: string,
  branch: string,
  moved: boolean,
  options: GitWorktreeExecOptions
): Promise<void> {
  let branchAttached = false
  if (moved) {
    try {
      const { stdout } = await gitExecFileAsync(
        ['symbolic-ref', '--short', 'HEAD'],
        gitCleanupOptions(cleanupPath, options)
      )
      branchAttached = stdout.trim() === branch
    } catch {
      // Detached or no longer readable.
    }
  }
  await performDiscardPreparedWorktree(repoPath, cleanupPath, options).catch(() => {})
  if (branchAttached) {
    await gitExecFileAsync(
      ['branch', '-D', '--', branch],
      gitCleanupOptions(repoPath, options)
    ).catch(() => {})
  }
}
