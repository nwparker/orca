import type { Worktree } from '../../../shared/types'
import { basename } from './path'

export type WorkItemWorkspaceAttachmentRef =
  | {
      provider: 'github'
      type: 'issue' | 'pr'
      repoId: string | null | undefined
      number: number
    }
  | {
      provider: 'gitlab'
      type: 'issue' | 'mr'
      repoId: string | null | undefined
      number: number
    }
  | {
      provider: 'linear'
      identifier: string | null | undefined
    }

export function findWorkItemWorkspaceAttachment(
  worktrees: readonly Worktree[],
  ref: WorkItemWorkspaceAttachmentRef
): Worktree | null {
  return worktrees.find((worktree) => isAttachedToWorkItem(worktree, ref)) ?? null
}

export function getWorkItemWorkspaceAttachmentLabel(worktree: Worktree): string {
  const displayName = worktree.displayName.trim()
  if (displayName) {
    return displayName
  }

  const branch = getBranchLabel(worktree.branch)
  if (branch) {
    return branch
  }

  return basename(worktree.path) || worktree.path
}

function isAttachedToWorkItem(worktree: Worktree, ref: WorkItemWorkspaceAttachmentRef): boolean {
  if (worktree.isArchived) {
    return false
  }

  switch (ref.provider) {
    case 'github':
      return (
        Boolean(ref.repoId) &&
        worktree.repoId === ref.repoId &&
        (ref.type === 'pr' ? worktree.linkedPR === ref.number : worktree.linkedIssue === ref.number)
      )
    case 'gitlab':
      return (
        Boolean(ref.repoId) &&
        worktree.repoId === ref.repoId &&
        (ref.type === 'mr'
          ? worktree.linkedGitLabMR === ref.number
          : worktree.linkedGitLabIssue === ref.number)
      )
    case 'linear':
      return Boolean(ref.identifier) && worktree.linkedLinearIssue === ref.identifier
  }
}

function getBranchLabel(branch: string | null | undefined): string | null {
  const trimmed = branch?.trim()
  if (!trimmed) {
    return null
  }

  if (trimmed.startsWith('refs/heads/')) {
    return trimmed.slice('refs/heads/'.length)
  }

  return trimmed
}
