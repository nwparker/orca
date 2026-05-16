/* eslint-disable max-lines -- Why: store coverage shares one persisted-state
   harness across load, refresh, reset, and aggregate cases. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'fs'
import type { ClaudeUsagePersistedState } from './types'

const scannerMocks = vi.hoisted(() => ({
  scanClaudeUsageFiles: vi.fn(),
  createWorktreeRefs: vi.fn(() => [{ repoId: 'repo-1', worktreeId: 'wt-1', path: '/repo' }])
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp/orca-test-userdata')
  }
}))

vi.mock('./scanner', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    createWorktreeRefs: scannerMocks.createWorktreeRefs,
    scanClaudeUsageFiles: scannerMocks.scanClaudeUsageFiles
  }
})

vi.mock('../usage-worktree-metadata', () => ({
  loadKnownUsageWorktreesByRepo: vi.fn(
    () => new Map([['repo-1', [{ worktreeId: 'wt-1', path: '/repo' }]]])
  )
}))

import { ClaudeUsageStore } from './store'

function createStoreWithState(state: Partial<ClaudeUsagePersistedState>): ClaudeUsageStore {
  const store = new ClaudeUsageStore({
    getRepos: () => [],
    getWorktreeMeta: () => undefined
  } as never)

  ;(store as unknown as { state: ClaudeUsagePersistedState }).state = {
    schemaVersion: 1,
    worktreeFingerprint: null,
    processedFiles: [],
    sessions: [],
    dailyAggregates: [],
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    },
    ...state
  }

  return store
}

describe('ClaudeUsageStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-09T12:00:00.000-04:00'))
    vi.clearAllMocks()
    rmSync('/tmp/orca-test-userdata', { recursive: true, force: true })
    scannerMocks.createWorktreeRefs.mockReturnValue([
      { repoId: 'repo-1', worktreeId: 'wt-1', path: '/repo' }
    ])
  })

  it('reports no data for Orca scope when only non-Orca usage exists', async () => {
    const store = createStoreWithState({
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-09T10:00:00.000Z',
          lastTimestamp: '2026-04-09T10:10:00.000Z',
          model: 'claude-sonnet-4-6',
          lastCwd: '/outside/repo',
          lastGitBranch: 'feature/outside',
          primaryWorktreeId: null,
          primaryRepoId: null,
          turnCount: 1,
          totalInputTokens: 100,
          totalOutputTokens: 20,
          totalCacheReadTokens: 10,
          totalCacheWriteTokens: 5,
          locationBreakdown: [
            {
              locationKey: 'cwd:/outside/repo',
              projectLabel: 'outside/repo',
              repoId: null,
              worktreeId: null,
              turnCount: 1,
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 10,
              cacheWriteTokens: 5
            }
          ]
        }
      ],
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-sonnet-4-6',
          projectKey: 'cwd:/outside/repo',
          projectLabel: 'outside/repo',
          repoId: null,
          worktreeId: null,
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.hasAnyClaudeData).toBe(false)
    expect(summary.sessions).toBe(0)
    expect(summary.turns).toBe(0)
    expect(summary.zeroCacheReadTurns).toBe(0)
  })

  it('filters sessions by local calendar day instead of raw UTC date prefixes', async () => {
    const store = createStoreWithState({
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-03T23:40:00.000-04:00',
          lastTimestamp: '2026-04-03T23:55:00.000-04:00',
          model: 'claude-sonnet-4-6',
          lastCwd: '/workspace/repo-a',
          lastGitBranch: 'feature/a',
          primaryWorktreeId: 'repo-1::/workspace/repo-a',
          primaryRepoId: 'repo-1',
          turnCount: 1,
          totalInputTokens: 100,
          totalOutputTokens: 20,
          totalCacheReadTokens: 10,
          totalCacheWriteTokens: 5,
          locationBreakdown: [
            {
              locationKey: 'worktree:repo-1::/workspace/repo-a',
              projectLabel: 'Repo A',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo-a',
              turnCount: 1,
              inputTokens: 100,
              outputTokens: 20,
              cacheReadTokens: 10,
              cacheWriteTokens: 5
            }
          ]
        }
      ],
      dailyAggregates: [
        {
          day: '2026-04-03',
          model: 'claude-sonnet-4-6',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5
        }
      ]
    })

    const recentSessions = await store.getRecentSessions('orca', '7d', 10)

    expect(recentSessions).toHaveLength(1)
    expect(recentSessions[0]?.sessionId).toBe('session-1')
  })

  it('reports zero-cache-read turns from daily aggregates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-sonnet-4-6',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 5,
          zeroCacheReadTurnCount: 2,
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 10,
          cacheWriteTokens: 5
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.turns).toBe(5)
    expect(summary.zeroCacheReadTurns).toBe(2)
  })

  it('prices Claude Opus 4.7 with current Anthropic rates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-opus-4-7-20260416',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')
    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(summary.estimatedCostUsd).toBeCloseTo(36.75)
    expect(
      breakdown.find((row) => row.key === 'claude-opus-4-7-20260416')?.estimatedCostUsd
    ).toBeCloseTo(36.75)
  })

  it('does not collapse older Opus 4.1 usage into current Opus 4.7 pricing', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-opus-4-1-20250805',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cacheReadTokens: 1_000_000,
          cacheWriteTokens: 1_000_000
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.estimatedCostUsd).toBeCloseTo(110.25)
  })

  it('prices Sonnet long-context usage with threshold rates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'claude-sonnet-4-6',
          projectKey: 'worktree:repo-1::/workspace/repo-a',
          projectLabel: 'Repo A',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo-a',
          turnCount: 1,
          zeroCacheReadTurnCount: 0,
          inputTokens: 300_000,
          outputTokens: 300_000,
          cacheReadTokens: 300_000,
          cacheWriteTokens: 300_000
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.estimatedCostUsd).toBeCloseTo(8.07)
  })

  it('returns automation usage for a single matching worktree session', async () => {
    const worktreeId = 'repo-1::/workspace/repo-a'
    const store = createStoreWithState({
      scanState: {
        enabled: true,
        lastScanStartedAt: 1,
        lastScanCompletedAt: 2,
        lastScanError: null
      },
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-09T15:00:00.000Z',
          lastTimestamp: '2026-04-09T15:05:00.000Z',
          model: 'claude-sonnet-4-6',
          lastCwd: '/workspace/repo-a',
          lastGitBranch: 'feature/a',
          primaryWorktreeId: worktreeId,
          primaryRepoId: 'repo-1',
          turnCount: 1,
          totalInputTokens: 1000,
          totalOutputTokens: 500,
          totalCacheReadTokens: 200,
          totalCacheWriteTokens: 100,
          locationBreakdown: [
            {
              locationKey: `worktree:${worktreeId}`,
              projectLabel: 'Repo A',
              repoId: 'repo-1',
              worktreeId,
              turnCount: 1,
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadTokens: 200,
              cacheWriteTokens: 100
            }
          ]
        }
      ]
    })
    ;(store as unknown as { refresh: typeof store.refresh }).refresh = vi.fn().mockResolvedValue({
      enabled: true,
      isScanning: false,
      lastScanStartedAt: 1,
      lastScanCompletedAt: 2,
      lastScanError: null,
      hasAnyClaudeData: true
    })

    const usage = await store.getAutomationRunUsage({
      worktreeId,
      terminalSessionId: 'tab-1',
      startedAt: new Date('2026-04-09T14:59:00.000Z').getTime(),
      completedAt: new Date('2026-04-09T15:06:00.000Z').getTime()
    })

    expect(usage.status).toBe('known')
    expect(usage.providerSessionId).toBe('session-1')
    expect(usage.totalTokens).toBe(1800)
    expect(usage.estimatedCostUsd).toBeCloseTo(0.010935)
  })

  it('persists enabled scan results and skips fresh refreshes', async () => {
    const sessions: ClaudeUsagePersistedState['sessions'] = [
      {
        sessionId: 'session-scan',
        firstTimestamp: '2026-04-09T10:00:00.000Z',
        lastTimestamp: '2026-04-09T10:05:00.000Z',
        model: 'claude-haiku-3-5',
        lastCwd: '/repo',
        lastGitBranch: 'main',
        primaryWorktreeId: 'wt-1',
        primaryRepoId: 'repo-1',
        turnCount: 1,
        totalInputTokens: 10,
        totalOutputTokens: 5,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        locationBreakdown: [
          {
            locationKey: 'worktree:wt-1',
            projectLabel: 'Repo',
            repoId: 'repo-1',
            worktreeId: 'wt-1',
            turnCount: 1,
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0
          }
        ]
      }
    ]
    const dailyAggregates: ClaudeUsagePersistedState['dailyAggregates'] = [
      {
        day: '2026-04-09',
        model: 'claude-haiku-3-5',
        projectKey: 'worktree:wt-1',
        projectLabel: 'Repo',
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        turnCount: 1,
        zeroCacheReadTurnCount: 1,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }
    ]
    scannerMocks.scanClaudeUsageFiles.mockResolvedValue({
      processedFiles: [{ filePath: '/tmp/log.jsonl', mtimeMs: 1, size: 10 }],
      sessions,
      dailyAggregates
    })
    const backingStore = {
      getRepos: () => [{ id: 'repo-1', path: '/repo', displayName: 'Repo' }],
      getWorktreeMeta: () => undefined
    }
    const store = new ClaudeUsageStore(backingStore as never)

    await expect(store.setEnabled(true)).resolves.toMatchObject({ enabled: true })
    await expect(store.refresh()).resolves.toMatchObject({
      enabled: true,
      lastScanStartedAt: Date.now(),
      lastScanCompletedAt: Date.now(),
      lastScanError: null,
      hasAnyClaudeData: true
    })
    expect(scannerMocks.createWorktreeRefs).toHaveBeenCalled()
    expect(scannerMocks.scanClaudeUsageFiles).toHaveBeenCalledTimes(1)
    await store.refresh()
    expect(scannerMocks.scanClaudeUsageFiles).toHaveBeenCalledTimes(1)
    await expect(store.getDaily('orca', '30d')).resolves.toEqual([
      {
        day: '2026-04-09',
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0
      }
    ])
  })

  it('serializes concurrent scans and records scan errors without throwing', async () => {
    const pendingScan = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('scan failed')), 10)
    })
    scannerMocks.scanClaudeUsageFiles.mockReturnValueOnce(pendingScan)
    const store = new ClaudeUsageStore({
      getRepos: () => [],
      getWorktreeMeta: () => undefined
    } as never)
    await store.setEnabled(true)

    const first = store.refresh(true)
    const second = store.refresh(true)
    await vi.advanceTimersByTimeAsync(10)
    await first
    await second

    expect(scannerMocks.scanClaudeUsageFiles).toHaveBeenCalledTimes(1)
    expect(store.getScanState()).toMatchObject({
      enabled: true,
      isScanning: false,
      lastScanError: 'scan failed'
    })
  })
})
