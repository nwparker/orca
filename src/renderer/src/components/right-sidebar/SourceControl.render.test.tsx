import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const noop = vi.fn()
  const activeWorktree = {
    id: 'wt-1',
    repoId: 'repo-1',
    path: '/repo',
    branch: 'refs/heads/feature/source-control',
    pushTarget: undefined,
    linkedPR: null,
    linkedGitLabMR: null
  }
  const gitRepo = {
    id: 'repo-1',
    kind: 'git',
    path: '/repo',
    name: 'repo',
    worktreeBaseRef: 'origin/main',
    connectionId: null
  }
  const folderRepo = { ...gitRepo, kind: 'folder' }
  const storeState = {
    activeWorktreeId: 'wt-1',
    activeGroupIdByWorktree: { 'wt-1': 'group-1' },
    rightSidebarTab: 'source-control',
    rightSidebarOpen: true,
    gitStatusByWorktree: {
      'wt-1': [
        {
          path: 'src/conflict.ts',
          status: 'modified',
          area: 'unstaged',
          conflictStatus: 'unresolved',
          conflictKind: 'both_modified'
        },
        { path: 'src/ready.ts', status: 'modified', area: 'unstaged' },
        { path: 'src/staged.ts', status: 'added', area: 'staged' },
        { path: 'docs/new.md', status: 'untracked', area: 'untracked' }
      ]
    },
    gitConflictOperationByWorktree: { 'wt-1': 'merge' },
    gitBranchChangesByWorktree: {
      'wt-1': [{ path: 'src/branch.ts', status: 'modified' }]
    },
    gitBranchCompareSummaryByWorktree: {
      'wt-1': {
        status: 'ready',
        baseRef: 'origin/main',
        baseOid: 'base',
        compareRef: 'feature/source-control',
        headOid: 'head',
        mergeBase: 'base',
        commitsAhead: 3,
        changedFiles: 1
      }
    },
    gitBranchCompareRequestKeyByWorktree: {},
    remoteStatusesByWorktree: { 'wt-1': { hasUpstream: true, ahead: 1, behind: 0 } },
    isRemoteOperationActive: false,
    inFlightRemoteOpKind: null,
    settings: {},
    hostedReviewCache: {},
    setGitStatus: noop,
    updateWorktreeGitIdentity: noop,
    beginGitBranchCompareRequest: noop,
    setGitBranchCompareResult: noop,
    fetchUpstreamStatus: vi.fn(() => Promise.resolve()),
    setUpstreamStatus: noop,
    pushBranch: vi.fn(() => Promise.resolve()),
    pullBranch: vi.fn(() => Promise.resolve()),
    syncBranch: vi.fn(() => Promise.resolve()),
    fetchBranch: vi.fn(() => Promise.resolve()),
    revealInExplorer: noop,
    trackConflictPath: noop,
    openDiff: noop,
    openFile: noop,
    setEditorViewMode: noop,
    openConflictFile: noop,
    openConflictReview: noop,
    openBranchDiff: noop,
    openAllDiffs: noop,
    openBranchAllDiffs: noop,
    deleteDiffComment: noop,
    setScrollToDiffCommentId: noop,
    fetchHostedReviewForBranch: noop,
    updateRepo: vi.fn(() => Promise.resolve()),
    getDiffComments: vi.fn(() => [
      { id: 'note-1', filePath: 'src/ready.ts', lineNumber: 4, body: 'Review this branch' }
    ])
  }
  return {
    activeWorktree,
    folderRepo,
    gitRepo,
    noop,
    repoMode: 'git' as 'git' | 'folder' | 'none',
    storeState,
    worktreeMode: 'active' as 'active' | 'none'
  }
})

vi.mock('@/store', () => {
  const useAppStore = vi.fn((selector: (state: typeof mocks.storeState) => unknown) =>
    selector(mocks.storeState)
  )
  Object.assign(useAppStore, {
    getState: () => mocks.storeState,
    setState: vi.fn(
      (updater: (state: typeof mocks.storeState) => Partial<typeof mocks.storeState>) => {
        Object.assign(mocks.storeState, updater(mocks.storeState))
      }
    )
  })
  return { useAppStore }
})

vi.mock('@/store/selectors', () => ({
  useActiveWorktree: vi.fn(() => (mocks.worktreeMode === 'active' ? mocks.activeWorktree : null)),
  useRepoById: vi.fn(() => {
    if (mocks.repoMode === 'git') {
      return mocks.gitRepo
    }
    if (mocks.repoMode === 'folder') {
      return mocks.folderRepo
    }
    return null
  }),
  useWorktreeMap: vi.fn(() => new Map([['wt-1', mocks.activeWorktree]]))
}))

function Passthrough({
  children
}: React.PropsWithChildren<Record<string, unknown>>): React.JSX.Element {
  return <div>{children}</div>
}

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: Passthrough,
  TooltipContent: Passthrough,
  TooltipProvider: Passthrough,
  TooltipTrigger: Passthrough
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: Passthrough,
  DropdownMenuContent: Passthrough,
  DropdownMenuItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div {...props}>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: Passthrough
}))

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: Passthrough,
  ContextMenuContent: Passthrough,
  ContextMenuItem: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => (
    <div {...props}>{children}</div>
  ),
  ContextMenuTrigger: Passthrough
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: Passthrough,
  DialogContent: Passthrough,
  DialogDescription: Passthrough,
  DialogFooter: Passthrough,
  DialogHeader: Passthrough,
  DialogTitle: Passthrough
}))

vi.mock('@/components/settings/BaseRefPicker', () => ({
  BaseRefPicker: ({ currentBaseRef }: { currentBaseRef?: string }) => (
    <div data-testid="base-ref-picker">{currentBaseRef ?? 'primary'}</div>
  )
}))

vi.mock('@/components/tab-bar/QuickLaunchButton', () => ({
  QuickLaunchAgentMenuItems: () => <div data-testid="quick-launch-items" />
}))

vi.mock('@/components/editor/editor-autosave', () => ({
  notifyEditorExternalFileChange: vi.fn(),
  requestEditorSaveQuiesce: vi.fn(() => Promise.resolve())
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('@/lib/focus-terminal-tab-surface', () => ({
  focusTerminalTabSurface: vi.fn()
}))

vi.mock('@/runtime/runtime-git-client', () => ({
  bulkStageRuntimeGitPaths: vi.fn(() => Promise.resolve()),
  bulkUnstageRuntimeGitPaths: vi.fn(() => Promise.resolve()),
  commitRuntimeGit: vi.fn(() => Promise.resolve({ success: true })),
  discardRuntimeGitPath: vi.fn(() => Promise.resolve()),
  getRuntimeGitBranchCompare: vi.fn(() =>
    Promise.resolve({
      summary: mocks.storeState.gitBranchCompareSummaryByWorktree['wt-1'],
      entries: []
    })
  ),
  stageRuntimeGitPath: vi.fn(() => Promise.resolve()),
  unstageRuntimeGitPath: vi.fn(() => Promise.resolve())
}))

vi.mock('@/runtime/runtime-repo-client', () => ({
  getRuntimeRepoBaseRefDefault: vi.fn(() =>
    Promise.resolve({ defaultBaseRef: 'origin/main', remoteCount: 1 })
  )
}))

vi.mock('./checks-panel-content', () => ({
  PullRequestIcon: ({ className }: { className?: string }) => <svg className={className} />
}))

vi.mock('./BulkActionBar', () => ({
  BulkActionBar: ({ selectedCount }: { selectedCount: number }) => (
    <div data-testid="bulk-action-bar">{selectedCount}</div>
  )
}))

vi.mock('./useSourceControlSelection', () => ({
  useSourceControlSelection: vi.fn(() => ({
    selectedKeys: new Set<string>(),
    handleSelect: vi.fn(),
    handleContextMenu: vi.fn(),
    clearSelection: vi.fn()
  }))
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

import SourceControl from './SourceControl'

describe('SourceControl initial render', () => {
  beforeEach(() => {
    mocks.repoMode = 'git'
    mocks.worktreeMode = 'active'
    mocks.storeState.activeWorktreeId = 'wt-1'
    vi.clearAllMocks()
  })

  it('renders the no-worktree empty state before any Git controls', () => {
    mocks.worktreeMode = 'none'
    mocks.storeState.activeWorktreeId = null as never
    mocks.repoMode = 'none'

    const html = renderToStaticMarkup(<SourceControl />)

    expect(html).toContain('Select a worktree to view changes')
  })

  it('renders the folder-repo unavailable state', () => {
    mocks.repoMode = 'folder'

    const html = renderToStaticMarkup(<SourceControl />)

    expect(html).toContain('Source Control is only available for Git repositories')
  })

  it('renders uncommitted, conflict, notes, and branch sections for a Git worktree', () => {
    const html = renderToStaticMarkup(<SourceControl />)

    expect(html).toContain('All')
    expect(html).toContain('Uncommitted')
    expect(html).toContain('3 commits ahead')
    expect(html).toContain('Notes')
    expect(html).toContain('Merge conflicts: 1 unresolved')
    expect(html).toContain('Changes')
    expect(html).toContain('Staged Changes')
    expect(html).toContain('Untracked Files')
    expect(html).toContain('Committed on Branch')
    expect(html).toContain('src/conflict.ts')
    expect(html).toContain('src/staged.ts')
    expect(html).toContain('docs/new.md')
    expect(html).toContain('branch.ts')
    expect(html).toContain('data-testid="base-ref-picker"')
  })
})
