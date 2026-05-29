import type { Worktree } from '../../../shared/types'
import {
  findWorkItemWorkspaceAttachment,
  getWorkItemWorkspaceAttachmentLabel
} from './work-item-workspace-attachment'

export function findGithubPrWorkspaceAttachment(
  worktrees: readonly Worktree[],
  repoId: string | null | undefined,
  prNumber: number
): Worktree | null {
  return findWorkItemWorkspaceAttachment(worktrees, {
    provider: 'github',
    type: 'pr',
    repoId,
    number: prNumber
  })
}

export function getGithubPrWorkspaceAttachmentLabel(worktree: Worktree): string {
  return getWorkItemWorkspaceAttachmentLabel(worktree)
}
