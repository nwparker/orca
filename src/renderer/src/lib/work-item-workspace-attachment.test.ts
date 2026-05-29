import { describe, expect, it } from 'vitest'

import {
  findWorkItemWorkspaceAttachment,
  getWorkItemWorkspaceAttachmentLabel
} from './work-item-workspace-attachment'
import type { Worktree } from '../../../shared/types'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    repoId: overrides.repoId ?? 'repo-1',
    path: overrides.path ?? '/tmp/repo-1/wt-1',
    head: 'abc123',
    branch: overrides.branch ?? 'refs/heads/feature/work-item',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.displayName ?? 'Work item workspace',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

describe('work item workspace attachment', () => {
  it('finds non-archived GitHub issue workspaces by repo and number', () => {
    const attached = worktree({ linkedIssue: 3346 })

    expect(
      findWorkItemWorkspaceAttachment([attached], {
        provider: 'github',
        type: 'issue',
        repoId: 'repo-1',
        number: 3346
      })
    ).toBe(attached)
  })

  it('keeps GitHub issue and GitLab issue metadata separate', () => {
    const gitlabOnly = worktree({ linkedGitLabIssue: 3346 })

    expect(
      findWorkItemWorkspaceAttachment([gitlabOnly], {
        provider: 'github',
        type: 'issue',
        repoId: 'repo-1',
        number: 3346
      })
    ).toBeNull()
    expect(
      findWorkItemWorkspaceAttachment([gitlabOnly], {
        provider: 'gitlab',
        type: 'issue',
        repoId: 'repo-1',
        number: 3346
      })
    ).toBe(gitlabOnly)
  })

  it('ignores archived and cross-repo workspaces', () => {
    const archived = worktree({ linkedIssue: 3346, isArchived: true })
    const otherRepo = worktree({ repoId: 'repo-2', linkedIssue: 3346 })

    expect(
      findWorkItemWorkspaceAttachment([archived, otherRepo], {
        provider: 'github',
        type: 'issue',
        repoId: 'repo-1',
        number: 3346
      })
    ).toBeNull()
  })

  it('finds Linear workspaces by identifier without requiring a git repo', () => {
    const attached = worktree({ linkedLinearIssue: 'ENG-123' })

    expect(
      findWorkItemWorkspaceAttachment([attached], {
        provider: 'linear',
        identifier: 'ENG-123'
      })
    ).toBe(attached)
  })

  it('labels attachments without exposing a full path when display or branch is available', () => {
    expect(getWorkItemWorkspaceAttachmentLabel(worktree({ displayName: '  Named issue  ' }))).toBe(
      'Named issue'
    )
    expect(
      getWorkItemWorkspaceAttachmentLabel(
        worktree({ displayName: '', branch: 'refs/heads/fix-ci' })
      )
    ).toBe('fix-ci')
    expect(
      getWorkItemWorkspaceAttachmentLabel(
        worktree({ displayName: '', branch: '', path: 'C:\\repo\\workspace-tail' })
      )
    ).toBe('workspace-tail')
  })
})
