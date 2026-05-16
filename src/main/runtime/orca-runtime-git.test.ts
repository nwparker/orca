/* eslint-disable max-lines -- Why: runtime git coverage shares one mocked host
   across local, SSH, path normalization, and commit-message dispatch cases. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeGitCommands, type RuntimeGitCommandHost } from './orca-runtime-git'
import type { GitPushTarget, GitWorktreeInfo, GlobalSettings, Worktree } from '../../shared/types'
import type { CommitMessageDraftContext } from '../../shared/commit-message-generation'

const gitMocks = vi.hoisted(() => ({
  getStatus: vi.fn(async () => ({ branch: 'main' })),
  detectConflictOperation: vi.fn(async () => ({ type: 'none' })),
  getDiff: vi.fn(async () => ({ kind: 'text', originalContent: 'a', modifiedContent: 'b' })),
  getBranchCompare: vi.fn(async () => ({ ahead: 1, behind: 0, files: [] })),
  getBranchDiff: vi.fn(async () => ({
    kind: 'text',
    originalContent: 'old',
    modifiedContent: 'new'
  })),
  getStagedCommitContext: vi.fn(),
  stageFile: vi.fn(async () => undefined),
  unstageFile: vi.fn(async () => undefined),
  bulkStageFiles: vi.fn(async () => undefined),
  bulkUnstageFiles: vi.fn(async () => undefined),
  bulkDiscardChanges: vi.fn(async () => undefined),
  discardChanges: vi.fn(async () => undefined),
  commitChanges: vi.fn(async () => ({ success: true }))
}))

const remoteMocks = vi.hoisted(() => ({
  gitFetch: vi.fn(async () => undefined),
  gitPull: vi.fn(async () => undefined),
  gitPush: vi.fn(async () => undefined),
  getUpstreamStatus: vi.fn(async () => ({ hasUpstream: true, ahead: 0, behind: 0 })),
  getRemoteFileUrl: vi.fn(async () => 'https://example.com/repo/blob/main/src/file.ts#L12')
}))

const commitMessageMocks = vi.hoisted(() => ({
  generateCommitMessageFromContext: vi.fn(),
  resolveCommitMessageSettings: vi.fn(),
  cancelGenerateCommitMessageLocal: vi.fn()
}))

const sshGitMock = vi.hoisted(() => ({
  provider: null as Record<string, unknown> | null,
  getSshGitProvider: vi.fn(() => sshGitMock.provider)
}))

vi.mock('../git/status', () => ({
  getStatus: gitMocks.getStatus,
  detectConflictOperation: gitMocks.detectConflictOperation,
  getDiff: gitMocks.getDiff,
  getBranchCompare: gitMocks.getBranchCompare,
  getBranchDiff: gitMocks.getBranchDiff,
  getStagedCommitContext: gitMocks.getStagedCommitContext,
  stageFile: gitMocks.stageFile,
  unstageFile: gitMocks.unstageFile,
  bulkStageFiles: gitMocks.bulkStageFiles,
  bulkUnstageFiles: gitMocks.bulkUnstageFiles,
  bulkDiscardChanges: gitMocks.bulkDiscardChanges,
  discardChanges: gitMocks.discardChanges,
  commitChanges: gitMocks.commitChanges
}))

vi.mock('../git/upstream', () => ({
  getUpstreamStatus: remoteMocks.getUpstreamStatus
}))

vi.mock('../git/remote', () => ({
  gitFetch: remoteMocks.gitFetch,
  gitPull: remoteMocks.gitPull,
  gitPush: remoteMocks.gitPush
}))

vi.mock('../git/repo', () => ({
  getRemoteFileUrl: remoteMocks.getRemoteFileUrl
}))

vi.mock('../text-generation/commit-message-text-generation', () => ({
  generateCommitMessageFromContext: commitMessageMocks.generateCommitMessageFromContext,
  resolveCommitMessageSettings: commitMessageMocks.resolveCommitMessageSettings,
  cancelGenerateCommitMessageLocal: commitMessageMocks.cancelGenerateCommitMessageLocal
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: sshGitMock.getSshGitProvider
}))

function worktree(overrides: Partial<Worktree> = {}): Worktree & { git: GitWorktreeInfo } {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    displayName: 'main',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    path: '/repo',
    head: 'abc123',
    branch: 'main',
    isBare: false,
    isMainWorktree: true,
    git: {
      path: '/repo',
      head: 'abc123',
      branch: 'main',
      isBare: false,
      isMainWorktree: true
    },
    ...overrides
  } as Worktree & { git: GitWorktreeInfo }
}

function host(
  connectionId?: string,
  settings: Partial<GlobalSettings> = {}
): RuntimeGitCommandHost {
  return {
    resolveRuntimeGitTarget: vi.fn(async () => ({
      worktree: worktree(),
      ...(connectionId ? { connectionId } : {})
    })),
    getRuntimeSettings: vi.fn(() => settings as GlobalSettings)
  }
}

function provider() {
  return {
    getStatus: vi.fn(async () => ({ branch: 'remote-main' })),
    detectConflictOperation: vi.fn(async () => ({ type: 'rebase' })),
    getDiff: vi.fn(async () => ({ kind: 'text', originalContent: 'r1', modifiedContent: 'r2' })),
    getBranchCompare: vi.fn(async () => ({ ahead: 2, behind: 1, files: [] })),
    getUpstreamStatus: vi.fn(async () => ({ hasUpstream: true, ahead: 2, behind: 1 })),
    fetchRemote: vi.fn(async () => undefined),
    pullBranch: vi.fn(async () => undefined),
    pushBranch: vi.fn(async () => undefined),
    getBranchDiff: vi.fn(async () => [
      { kind: 'text', originalContent: 'remote-old', modifiedContent: 'remote-new' }
    ]),
    getStagedCommitContext: vi.fn(async () => ({
      branch: 'remote-main',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+remote'
    })),
    executeCommitMessagePlan: vi.fn(async () => ({ exitCode: 0, stdout: 'message', stderr: '' })),
    cancelGenerateCommitMessage: vi.fn(),
    commit: vi.fn(async () => ({ success: true })),
    stageFile: vi.fn(async () => undefined),
    unstageFile: vi.fn(async () => undefined),
    bulkStageFiles: vi.fn(async () => undefined),
    bulkUnstageFiles: vi.fn(async () => undefined),
    bulkDiscardChanges: vi.fn(async () => undefined),
    discardChanges: vi.fn(async () => undefined),
    getRemoteFileUrl: vi.fn(async () => 'ssh://remote/src/file.ts:12')
  }
}

describe('RuntimeGitCommands', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sshGitMock.provider = null
    gitMocks.getStatus.mockResolvedValue({ branch: 'main' })
    gitMocks.detectConflictOperation.mockResolvedValue({ type: 'none' })
    gitMocks.getDiff.mockResolvedValue({ kind: 'text', originalContent: 'a', modifiedContent: 'b' })
    gitMocks.getBranchCompare.mockResolvedValue({ ahead: 1, behind: 0, files: [] })
    gitMocks.getBranchDiff.mockResolvedValue({
      kind: 'text',
      originalContent: 'old',
      modifiedContent: 'new'
    })
    gitMocks.getStagedCommitContext.mockResolvedValue(null)
    gitMocks.commitChanges.mockResolvedValue({ success: true })
    remoteMocks.getUpstreamStatus.mockResolvedValue({ hasUpstream: true, ahead: 0, behind: 0 })
    remoteMocks.getRemoteFileUrl.mockResolvedValue(
      'https://example.com/repo/blob/main/src/file.ts#L12'
    )
    commitMessageMocks.resolveCommitMessageSettings.mockReturnValue({
      ok: true,
      params: { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    })
    commitMessageMocks.generateCommitMessageFromContext.mockResolvedValue({
      success: true,
      message: 'docs: update readme'
    })
  })

  it('dispatches local git commands with normalized relative paths', async () => {
    const commands = new RuntimeGitCommands(host())
    const pushTarget: GitPushTarget = { remoteName: 'origin', branchName: 'feature' }

    await expect(commands.getRuntimeGitStatus('id:wt-1')).resolves.toEqual({ branch: 'main' })
    await expect(commands.getRuntimeGitConflictOperation('id:wt-1')).resolves.toEqual({
      type: 'none'
    })
    await expect(
      commands.getRuntimeGitDiff('id:wt-1', 'src\\file.ts', true, true)
    ).resolves.toEqual(expect.objectContaining({ modifiedContent: 'b' }))
    await expect(commands.getRuntimeGitBranchCompare('id:wt-1', 'origin/main')).resolves.toEqual(
      expect.objectContaining({ ahead: 1 })
    )
    await expect(commands.getRuntimeGitUpstreamStatus('id:wt-1')).resolves.toEqual({
      hasUpstream: true,
      ahead: 0,
      behind: 0
    })
    await expect(commands.fetchRuntimeGit('id:wt-1')).resolves.toEqual({ ok: true })
    await expect(commands.pullRuntimeGit('id:wt-1')).resolves.toEqual({ ok: true })
    await expect(commands.pushRuntimeGit('id:wt-1', true, pushTarget)).resolves.toEqual({
      ok: true
    })
    await expect(
      commands.getRuntimeGitBranchDiff(
        'id:wt-1',
        { mergeBase: 'base', headOid: 'head' },
        'src\\file.ts',
        'src\\old.ts'
      )
    ).resolves.toEqual(expect.objectContaining({ modifiedContent: 'new' }))
    await expect(commands.commitRuntimeGit('id:wt-1', 'commit message')).resolves.toEqual({
      success: true
    })
    await expect(commands.stageRuntimeGitPath('id:wt-1', 'src\\file.ts')).resolves.toEqual({
      ok: true
    })
    await expect(commands.unstageRuntimeGitPath('id:wt-1', 'src\\file.ts')).resolves.toEqual({
      ok: true
    })
    await expect(
      commands.bulkStageRuntimeGitPaths('id:wt-1', ['src\\one.ts', 'src\\two.ts'])
    ).resolves.toEqual({ ok: true })
    await expect(
      commands.bulkUnstageRuntimeGitPaths('id:wt-1', ['src\\one.ts', 'src\\two.ts'])
    ).resolves.toEqual({ ok: true })
    await expect(
      commands.bulkDiscardRuntimeGitPaths('id:wt-1', ['src\\one.ts', 'src\\two.ts'])
    ).resolves.toEqual({ ok: true })
    await expect(commands.discardRuntimeGitPath('id:wt-1', 'src\\file.ts')).resolves.toEqual({
      ok: true
    })
    await expect(commands.getRuntimeGitRemoteFileUrl('id:wt-1', 'src\\file.ts', 12)).resolves.toBe(
      'https://example.com/repo/blob/main/src/file.ts#L12'
    )
    await expect(commands.cancelRuntimeGenerateCommitMessage('id:wt-1')).resolves.toEqual({
      ok: true
    })

    expect(gitMocks.getStatus).toHaveBeenCalledWith('/repo')
    expect(gitMocks.detectConflictOperation).toHaveBeenCalledWith('/repo')
    expect(gitMocks.getDiff).toHaveBeenCalledWith('/repo', 'src/file.ts', true, true)
    expect(gitMocks.getBranchCompare).toHaveBeenCalledWith('/repo', 'origin/main')
    expect(remoteMocks.getUpstreamStatus).toHaveBeenCalledWith('/repo')
    expect(remoteMocks.gitFetch).toHaveBeenCalledWith('/repo')
    expect(remoteMocks.gitPull).toHaveBeenCalledWith('/repo')
    expect(remoteMocks.gitPush).toHaveBeenCalledWith('/repo', true, pushTarget)
    expect(gitMocks.getBranchDiff).toHaveBeenCalledWith('/repo', {
      mergeBase: 'base',
      headOid: 'head',
      filePath: 'src/file.ts',
      oldPath: 'src/old.ts'
    })
    expect(gitMocks.commitChanges).toHaveBeenCalledWith('/repo', 'commit message')
    expect(gitMocks.stageFile).toHaveBeenCalledWith('/repo', 'src/file.ts')
    expect(gitMocks.unstageFile).toHaveBeenCalledWith('/repo', 'src/file.ts')
    expect(gitMocks.bulkStageFiles).toHaveBeenCalledWith('/repo', ['src/one.ts', 'src/two.ts'])
    expect(gitMocks.bulkUnstageFiles).toHaveBeenCalledWith('/repo', ['src/one.ts', 'src/two.ts'])
    expect(gitMocks.bulkDiscardChanges).toHaveBeenCalledWith('/repo', ['src/one.ts', 'src/two.ts'])
    expect(gitMocks.discardChanges).toHaveBeenCalledWith('/repo', 'src/file.ts')
    expect(remoteMocks.getRemoteFileUrl).toHaveBeenCalledWith('/repo', 'src/file.ts', 12)
    expect(commitMessageMocks.cancelGenerateCommitMessageLocal).toHaveBeenCalledWith('/repo')
  })

  it('dispatches remote git commands through the SSH provider', async () => {
    const remoteProvider = provider()
    sshGitMock.provider = remoteProvider
    const commands = new RuntimeGitCommands(host('ssh-1'))
    const pushTarget: GitPushTarget = { remoteName: 'origin', branchName: 'feature' }

    await commands.getRuntimeGitStatus('id:wt-1')
    await commands.getRuntimeGitConflictOperation('id:wt-1')
    await commands.getRuntimeGitDiff('id:wt-1', 'src\\file.ts', false)
    await commands.getRuntimeGitBranchCompare('id:wt-1', 'origin/main')
    await commands.getRuntimeGitUpstreamStatus('id:wt-1')
    await commands.fetchRuntimeGit('id:wt-1')
    await commands.pullRuntimeGit('id:wt-1')
    await commands.pushRuntimeGit('id:wt-1', false, pushTarget)
    await expect(
      commands.getRuntimeGitBranchDiff(
        'id:wt-1',
        { mergeBase: 'base', headOid: 'head' },
        'src\\file.ts',
        'src\\old.ts'
      )
    ).resolves.toEqual(expect.objectContaining({ modifiedContent: 'remote-new' }))
    await commands.commitRuntimeGit('id:wt-1', 'remote commit')
    await commands.stageRuntimeGitPath('id:wt-1', 'src\\file.ts')
    await commands.unstageRuntimeGitPath('id:wt-1', 'src\\file.ts')
    await commands.bulkStageRuntimeGitPaths('id:wt-1', ['src\\one.ts'])
    await commands.bulkUnstageRuntimeGitPaths('id:wt-1', ['src\\two.ts'])
    await commands.bulkDiscardRuntimeGitPaths('id:wt-1', ['src\\three.ts'])
    await commands.discardRuntimeGitPath('id:wt-1', 'src\\file.ts')
    await expect(commands.getRuntimeGitRemoteFileUrl('id:wt-1', 'src\\file.ts', 12)).resolves.toBe(
      'ssh://remote/src/file.ts:12'
    )
    await commands.cancelRuntimeGenerateCommitMessage('id:wt-1')

    expect(sshGitMock.getSshGitProvider).toHaveBeenCalledWith('ssh-1')
    expect(remoteProvider.getStatus).toHaveBeenCalledWith('/repo')
    expect(remoteProvider.detectConflictOperation).toHaveBeenCalledWith('/repo')
    expect(remoteProvider.getDiff).toHaveBeenCalledWith('/repo', 'src/file.ts', false, undefined)
    expect(remoteProvider.getBranchCompare).toHaveBeenCalledWith('/repo', 'origin/main')
    expect(remoteProvider.getUpstreamStatus).toHaveBeenCalledWith('/repo')
    expect(remoteProvider.fetchRemote).toHaveBeenCalledWith('/repo')
    expect(remoteProvider.pullBranch).toHaveBeenCalledWith('/repo')
    expect(remoteProvider.pushBranch).toHaveBeenCalledWith('/repo', false, pushTarget)
    expect(remoteProvider.getBranchDiff).toHaveBeenCalledWith('/repo', 'base', {
      includePatch: true,
      filePath: 'src/file.ts',
      oldPath: 'src/old.ts'
    })
    expect(remoteProvider.commit).toHaveBeenCalledWith('/repo', 'remote commit')
    expect(remoteProvider.stageFile).toHaveBeenCalledWith('/repo', 'src/file.ts')
    expect(remoteProvider.unstageFile).toHaveBeenCalledWith('/repo', 'src/file.ts')
    expect(remoteProvider.bulkStageFiles).toHaveBeenCalledWith('/repo', ['src/one.ts'])
    expect(remoteProvider.bulkUnstageFiles).toHaveBeenCalledWith('/repo', ['src/two.ts'])
    expect(remoteProvider.bulkDiscardChanges).toHaveBeenCalledWith('/repo', ['src/three.ts'])
    expect(remoteProvider.discardChanges).toHaveBeenCalledWith('/repo', 'src/file.ts')
    expect(remoteProvider.getRemoteFileUrl).toHaveBeenCalledWith('/repo', 'src/file.ts', 12)
    expect(remoteProvider.cancelGenerateCommitMessage).toHaveBeenCalledWith('/repo')
  })

  it('handles validation errors and unavailable remote providers', async () => {
    const remoteCommands = new RuntimeGitCommands(host('ssh-1'))
    await expect(remoteCommands.getRuntimeGitStatus('id:wt-1')).rejects.toThrow(
      'remote_git_unavailable'
    )

    const localCommands = new RuntimeGitCommands(host())
    await expect(localCommands.commitRuntimeGit('id:wt-1', '   ')).rejects.toThrow(
      'Commit message is required'
    )
    await expect(localCommands.stageRuntimeGitPath('id:wt-1', '../escape')).rejects.toThrow(
      'invalid_relative_path'
    )
    await expect(localCommands.bulkDiscardRuntimeGitPaths('id:wt-1', ['///'])).rejects.toThrow(
      'invalid_relative_path'
    )
    await expect(localCommands.discardRuntimeGitPath('id:wt-1', '///')).rejects.toThrow(
      'invalid_relative_path'
    )
  })

  it('returns an empty text diff when remote branch diff has no matching file', async () => {
    const remoteProvider = provider()
    remoteProvider.getBranchDiff.mockResolvedValueOnce([])
    sshGitMock.provider = remoteProvider
    const commands = new RuntimeGitCommands(host('ssh-1'))

    await expect(
      commands.getRuntimeGitBranchDiff(
        'id:wt-1',
        { mergeBase: 'base', headOid: 'head' },
        'src/missing.ts'
      )
    ).resolves.toEqual({
      kind: 'text',
      originalContent: '',
      modifiedContent: '',
      originalIsBinary: false,
      modifiedIsBinary: false
    })
  })

  it('prepares the selected local agent environment before generating commit messages', async () => {
    const context: CommitMessageDraftContext = {
      branch: 'main',
      stagedSummary: 'M\tREADME.md',
      stagedPatch: '+hello'
    }
    const params = { agentId: 'codex', model: 'gpt-5.4-mini', thinkingLevel: 'low' }
    commitMessageMocks.resolveCommitMessageSettings.mockReturnValue({ ok: true, params })
    gitMocks.getStagedCommitContext.mockResolvedValue(context)
    commitMessageMocks.generateCommitMessageFromContext.mockResolvedValue({
      success: true,
      message: 'docs: update readme'
    })
    const commands = new RuntimeGitCommands({
      ...host(undefined, {
        commitMessageAi: {
          enabled: true,
          agentId: 'codex',
          selectedModelByAgent: { codex: 'gpt-5.4-mini' },
          selectedThinkingByModel: { 'gpt-5.4-mini': 'low' },
          customPrompt: '',
          customAgentCommand: ''
        },
        agentCmdOverrides: {},
        enableGitHubAttribution: false
      }),
      getCommitMessageAgentEnvironment: () => ({
        prepareForCodexLaunch: () => '/managed/codex-home'
      })
    })

    await expect(commands.generateRuntimeCommitMessage('id:wt-1')).resolves.toEqual({
      success: true,
      message: 'docs: update readme'
    })

    expect(gitMocks.getStagedCommitContext).toHaveBeenCalledWith('/repo')
    expect(commitMessageMocks.generateCommitMessageFromContext).toHaveBeenCalledWith(
      context,
      params,
      expect.objectContaining({
        kind: 'local',
        cwd: '/repo',
        env: expect.objectContaining({ CODEX_HOME: '/managed/codex-home' })
      })
    )
  })
})
