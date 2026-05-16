/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'fs'
import type { CodexUsagePersistedState } from './types'

const { getPathMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/tmp/orca-test-userdata')
}))

const scannerMocks = vi.hoisted(() => ({
  scanCodexUsageFiles: vi.fn(),
  createWorktreeRefs: vi.fn(() => [{ repoId: 'repo-1', worktreeId: 'wt-1', path: '/repo' }])
}))

const usageMetadataMocks = vi.hoisted(() => ({
  loadKnownUsageWorktreesByRepo: vi.fn(
    () => new Map([['repo-1', [{ worktreeId: 'wt-1', path: '/repo', displayName: 'Repo' }]]])
  )
}))

vi.mock('electron', () => ({
  app: {
    getPath: getPathMock
  }
}))

vi.mock('./scanner', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    createWorktreeRefs: scannerMocks.createWorktreeRefs,
    scanCodexUsageFiles: scannerMocks.scanCodexUsageFiles
  }
})

vi.mock('../usage-worktree-metadata', () => ({
  loadKnownUsageWorktreesByRepo: usageMetadataMocks.loadKnownUsageWorktreesByRepo
}))

import { CodexUsageStore, normalizePersistedState } from './store'

function createStoreWithState(state: Partial<CodexUsagePersistedState>): CodexUsageStore {
  const store = new CodexUsageStore({
    getRepos: () => [],
    getWorktreeMeta: () => undefined
  } as never)

  ;(store as unknown as { state: CodexUsagePersistedState }).state = {
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

describe('CodexUsageStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-04-10T12:00:00.000-04:00'))
    vi.clearAllMocks()
    rmSync('/tmp/orca-test-userdata', { recursive: true, force: true })
    getPathMock.mockReturnValue('/tmp/orca-test-userdata')
    scannerMocks.createWorktreeRefs.mockReturnValue([
      { repoId: 'repo-1', worktreeId: 'wt-1', path: '/repo' }
    ])
    usageMetadataMocks.loadKnownUsageWorktreesByRepo.mockReturnValue(
      new Map([['repo-1', [{ worktreeId: 'wt-1', path: '/repo', displayName: 'Repo' }]]])
    )
  })

  it('reports no data for Orca scope when only non-Orca Codex usage exists', async () => {
    const store = createStoreWithState({
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-09T10:00:00.000Z',
          lastTimestamp: '2026-04-09T10:10:00.000Z',
          primaryModel: 'gpt-5',
          hasMixedModels: false,
          primaryProjectLabel: 'outside/repo',
          hasMixedLocations: false,
          primaryWorktreeId: null,
          primaryRepoId: null,
          eventCount: 1,
          totalInputTokens: 1000,
          totalCachedInputTokens: 400,
          totalOutputTokens: 250,
          totalReasoningOutputTokens: 100,
          totalTokens: 1250,
          hasInferredPricing: false,
          locationBreakdown: [
            {
              locationKey: 'cwd:/outside/repo',
              projectLabel: 'outside/repo',
              repoId: null,
              worktreeId: null,
              eventCount: 1,
              inputTokens: 1000,
              cachedInputTokens: 400,
              outputTokens: 250,
              reasoningOutputTokens: 100,
              totalTokens: 1250,
              hasInferredPricing: false
            }
          ],
          modelBreakdown: [
            {
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              eventCount: 1,
              inputTokens: 1000,
              cachedInputTokens: 400,
              outputTokens: 250,
              reasoningOutputTokens: 100,
              totalTokens: 1250,
              hasInferredPricing: false
            }
          ],
          locationModelBreakdown: [
            {
              locationKey: 'cwd:/outside/repo',
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              repoId: null,
              worktreeId: null,
              eventCount: 1,
              inputTokens: 1000,
              cachedInputTokens: 400,
              outputTokens: 250,
              reasoningOutputTokens: 100,
              totalTokens: 1250,
              hasInferredPricing: false
            }
          ]
        }
      ],
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5',
          projectKey: 'cwd:/outside/repo',
          projectLabel: 'outside/repo',
          repoId: null,
          worktreeId: null,
          eventCount: 1,
          inputTokens: 1000,
          cachedInputTokens: 400,
          outputTokens: 250,
          reasoningOutputTokens: 100,
          totalTokens: 1250,
          hasInferredPricing: false
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.hasAnyCodexData).toBe(false)
    expect(summary.sessions).toBe(0)
    expect(summary.events).toBe(0)
  })

  it('calculates cost from uncached input plus cached input without double billing', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 2,
          inputTokens: 1000,
          cachedInputTokens: 400,
          outputTokens: 250,
          reasoningOutputTokens: 100,
          totalTokens: 1250,
          hasInferredPricing: false
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.estimatedCostUsd).toBeCloseTo(0.0014)
    expect(summary.totalTokens).toBe(1250)
    expect(summary.reasoningOutputTokens).toBe(100)
  })

  it('prices current Codex models with current model rates', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5.2-codex',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 2_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 3_000_000,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.3-codex',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 2_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 3_000_000,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.4',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 2_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 3_000_000,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.5',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 2_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 3_000_000,
          hasInferredPricing: false
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')
    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(summary.estimatedCostUsd).toBeCloseTo(107.486)
    expect(breakdown.find((row) => row.key === 'gpt-5.2-codex')?.estimatedCostUsd).toBeCloseTo(
      15.925
    )
    expect(breakdown.find((row) => row.key === 'gpt-5.3-codex')?.estimatedCostUsd).toBeCloseTo(
      15.925
    )
    expect(breakdown.find((row) => row.key === 'gpt-5.4')?.estimatedCostUsd).toBeCloseTo(25.212)
    expect(breakdown.find((row) => row.key === 'gpt-5.5')?.estimatedCostUsd).toBeCloseTo(50.424)
  })

  it('normalizes Codex model variants and reasoning suffixes before pricing', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5.4-mini-high',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 1_000_000,
          cachedInputTokens: 500_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 2_000_000,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.3-codex-spark-xhigh',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 2_000_000,
          cachedInputTokens: 1_000_000,
          outputTokens: 1_000_000,
          reasoningOutputTokens: 100_000,
          totalTokens: 3_000_000,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.5(xhigh)',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 100_000,
          cachedInputTokens: 50_000,
          outputTokens: 25_000,
          reasoningOutputTokens: 5_000,
          totalTokens: 125_000,
          hasInferredPricing: false
        }
      ]
    })

    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(breakdown.find((row) => row.key === 'gpt-5.4-mini-high')?.estimatedCostUsd).toBeCloseTo(
      4.9125
    )
    expect(
      breakdown.find((row) => row.key === 'gpt-5.3-codex-spark-xhigh')?.estimatedCostUsd
    ).toBeCloseTo(15.925)
    expect(breakdown.find((row) => row.key === 'gpt-5.5(xhigh)')?.estimatedCostUsd).toBeCloseTo(
      1.025
    )
  })

  it('keeps cached input out of the full-price input bucket for GPT-5.5 totals', async () => {
    const store = createStoreWithState({
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5.5',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 491_053_514,
          cachedInputTokens: 459_283_584,
          outputTokens: 1_944_952,
          reasoningOutputTokens: 551_764,
          totalTokens: 492_998_466,
          hasInferredPricing: false
        }
      ]
    })

    const summary = await store.getSummary('orca', '30d')

    expect(summary.estimatedCostUsd).toBeCloseTo(858.929724)
  })

  it('counts mixed-model sessions once for each real model row in the breakdown', async () => {
    const store = createStoreWithState({
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-09T10:00:00.000Z',
          lastTimestamp: '2026-04-09T10:10:00.000Z',
          primaryModel: 'Mixed models',
          hasMixedModels: true,
          primaryProjectLabel: 'Repo',
          hasMixedLocations: false,
          primaryWorktreeId: 'repo-1::/workspace/repo',
          primaryRepoId: 'repo-1',
          eventCount: 2,
          totalInputTokens: 300,
          totalCachedInputTokens: 100,
          totalOutputTokens: 90,
          totalReasoningOutputTokens: 10,
          totalTokens: 390,
          hasInferredPricing: false,
          locationBreakdown: [
            {
              locationKey: 'worktree:repo-1::/workspace/repo',
              projectLabel: 'Repo',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo',
              eventCount: 2,
              inputTokens: 300,
              cachedInputTokens: 100,
              outputTokens: 90,
              reasoningOutputTokens: 10,
              totalTokens: 390,
              hasInferredPricing: false
            }
          ],
          modelBreakdown: [
            {
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              eventCount: 1,
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 30,
              reasoningOutputTokens: 5,
              totalTokens: 130,
              hasInferredPricing: false
            },
            {
              modelKey: 'gpt-5.2-codex',
              modelLabel: 'gpt-5.2-codex',
              eventCount: 1,
              inputTokens: 200,
              cachedInputTokens: 80,
              outputTokens: 60,
              reasoningOutputTokens: 5,
              totalTokens: 260,
              hasInferredPricing: false
            }
          ],
          locationModelBreakdown: [
            {
              locationKey: 'worktree:repo-1::/workspace/repo',
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo',
              eventCount: 1,
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 30,
              reasoningOutputTokens: 5,
              totalTokens: 130,
              hasInferredPricing: false
            },
            {
              locationKey: 'worktree:repo-1::/workspace/repo',
              modelKey: 'gpt-5.2-codex',
              modelLabel: 'gpt-5.2-codex',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo',
              eventCount: 1,
              inputTokens: 200,
              cachedInputTokens: 80,
              outputTokens: 60,
              reasoningOutputTokens: 5,
              totalTokens: 260,
              hasInferredPricing: false
            }
          ]
        }
      ],
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 5,
          totalTokens: 130,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.2-codex',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 200,
          cachedInputTokens: 80,
          outputTokens: 60,
          reasoningOutputTokens: 5,
          totalTokens: 260,
          hasInferredPricing: false
        }
      ]
    })

    const breakdown = await store.getBreakdown('orca', '30d', 'model')

    expect(breakdown.find((row) => row.key === 'gpt-5')?.sessions).toBe(1)
    expect(breakdown.find((row) => row.key === 'gpt-5.2-codex')?.sessions).toBe(1)
  })

  it('uses only Orca-scoped models when projecting mixed-scope sessions', async () => {
    const store = createStoreWithState({
      sessions: [
        {
          sessionId: 'session-1',
          firstTimestamp: '2026-04-09T10:00:00.000Z',
          lastTimestamp: '2026-04-09T10:10:00.000Z',
          primaryModel: 'Mixed models',
          hasMixedModels: true,
          primaryProjectLabel: 'Multiple locations',
          hasMixedLocations: true,
          primaryWorktreeId: 'repo-1::/workspace/repo',
          primaryRepoId: 'repo-1',
          eventCount: 2,
          totalInputTokens: 300,
          totalCachedInputTokens: 60,
          totalOutputTokens: 90,
          totalReasoningOutputTokens: 10,
          totalTokens: 390,
          hasInferredPricing: false,
          locationBreakdown: [
            {
              locationKey: 'worktree:repo-1::/workspace/repo',
              projectLabel: 'Repo',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo',
              eventCount: 1,
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 30,
              reasoningOutputTokens: 5,
              totalTokens: 130,
              hasInferredPricing: false
            },
            {
              locationKey: 'cwd:/outside/repo',
              projectLabel: 'outside/repo',
              repoId: null,
              worktreeId: null,
              eventCount: 1,
              inputTokens: 200,
              cachedInputTokens: 40,
              outputTokens: 60,
              reasoningOutputTokens: 5,
              totalTokens: 260,
              hasInferredPricing: false
            }
          ],
          modelBreakdown: [
            {
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              eventCount: 1,
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 30,
              reasoningOutputTokens: 5,
              totalTokens: 130,
              hasInferredPricing: false
            },
            {
              modelKey: 'gpt-5.2-codex',
              modelLabel: 'gpt-5.2-codex',
              eventCount: 1,
              inputTokens: 200,
              cachedInputTokens: 40,
              outputTokens: 60,
              reasoningOutputTokens: 5,
              totalTokens: 260,
              hasInferredPricing: false
            }
          ],
          locationModelBreakdown: [
            {
              locationKey: 'worktree:repo-1::/workspace/repo',
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              repoId: 'repo-1',
              worktreeId: 'repo-1::/workspace/repo',
              eventCount: 1,
              inputTokens: 100,
              cachedInputTokens: 20,
              outputTokens: 30,
              reasoningOutputTokens: 5,
              totalTokens: 130,
              hasInferredPricing: false
            },
            {
              locationKey: 'cwd:/outside/repo',
              modelKey: 'gpt-5.2-codex',
              modelLabel: 'gpt-5.2-codex',
              repoId: null,
              worktreeId: null,
              eventCount: 1,
              inputTokens: 200,
              cachedInputTokens: 40,
              outputTokens: 60,
              reasoningOutputTokens: 5,
              totalTokens: 260,
              hasInferredPricing: false
            }
          ]
        }
      ],
      dailyAggregates: [
        {
          day: '2026-04-09',
          model: 'gpt-5',
          projectKey: 'worktree:repo-1::/workspace/repo',
          projectLabel: 'Repo',
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo',
          eventCount: 1,
          inputTokens: 100,
          cachedInputTokens: 20,
          outputTokens: 30,
          reasoningOutputTokens: 5,
          totalTokens: 130,
          hasInferredPricing: false
        },
        {
          day: '2026-04-09',
          model: 'gpt-5.2-codex',
          projectKey: 'cwd:/outside/repo',
          projectLabel: 'outside/repo',
          repoId: null,
          worktreeId: null,
          eventCount: 1,
          inputTokens: 200,
          cachedInputTokens: 40,
          outputTokens: 60,
          reasoningOutputTokens: 5,
          totalTokens: 260,
          hasInferredPricing: false
        }
      ]
    })

    const breakdown = await store.getBreakdown('orca', '30d', 'model')
    const recentSessions = await store.getRecentSessions('orca', '30d', 10)

    expect(breakdown.find((row) => row.key === 'gpt-5')?.sessions).toBe(1)
    expect(breakdown.find((row) => row.key === 'gpt-5.2-codex')).toBeUndefined()
    expect(recentSessions[0]?.projectLabel).toBe('Repo')
    expect(recentSessions[0]?.model).toBe('gpt-5')
  })

  it('drops persisted caches from older schemas that lack scoped model breakdown data', () => {
    const normalized = normalizePersistedState({
      schemaVersion: 1,
      processedFiles: [],
      sessions: [
        {
          sessionId: 'legacy',
          firstTimestamp: '2026-04-09T10:00:00.000Z',
          lastTimestamp: '2026-04-09T10:10:00.000Z',
          primaryModel: 'gpt-5',
          hasMixedModels: false,
          primaryProjectLabel: 'Repo',
          hasMixedLocations: false,
          primaryWorktreeId: 'repo-1::/workspace/repo',
          primaryRepoId: 'repo-1',
          eventCount: 1,
          totalInputTokens: 1,
          totalCachedInputTokens: 0,
          totalOutputTokens: 1,
          totalReasoningOutputTokens: 0,
          totalTokens: 2,
          hasInferredPricing: false,
          locationBreakdown: [],
          modelBreakdown: []
        }
      ],
      dailyAggregates: [],
      scanState: {
        enabled: true,
        lastScanStartedAt: 1,
        lastScanCompletedAt: 2,
        lastScanError: null
      }
    } as unknown as CodexUsagePersistedState)

    expect(normalized).toEqual({
      schemaVersion: 3,
      worktreeFingerprint: null,
      processedFiles: [],
      sessions: [],
      dailyAggregates: [],
      scanState: {
        enabled: false,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null
      }
    })
  })

  it('returns automation usage for a single matching worktree session', async () => {
    const worktreeId = 'repo-1::/workspace/repo'
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
          firstTimestamp: '2026-04-10T15:00:00.000Z',
          lastTimestamp: '2026-04-10T15:05:00.000Z',
          primaryModel: 'gpt-5',
          hasMixedModels: false,
          primaryProjectLabel: 'Repo',
          hasMixedLocations: false,
          primaryWorktreeId: worktreeId,
          primaryRepoId: 'repo-1',
          eventCount: 1,
          totalInputTokens: 1000,
          totalCachedInputTokens: 400,
          totalOutputTokens: 250,
          totalReasoningOutputTokens: 100,
          totalTokens: 1250,
          hasInferredPricing: false,
          locationBreakdown: [
            {
              locationKey: `worktree:${worktreeId}`,
              projectLabel: 'Repo',
              repoId: 'repo-1',
              worktreeId,
              eventCount: 1,
              inputTokens: 1000,
              cachedInputTokens: 400,
              outputTokens: 250,
              reasoningOutputTokens: 100,
              totalTokens: 1250,
              hasInferredPricing: false
            }
          ],
          modelBreakdown: [
            {
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              eventCount: 1,
              inputTokens: 1000,
              cachedInputTokens: 400,
              outputTokens: 250,
              reasoningOutputTokens: 100,
              totalTokens: 1250,
              hasInferredPricing: false
            }
          ],
          locationModelBreakdown: [
            {
              locationKey: `worktree:${worktreeId}`,
              modelKey: 'gpt-5',
              modelLabel: 'gpt-5',
              repoId: 'repo-1',
              worktreeId,
              eventCount: 1,
              inputTokens: 1000,
              cachedInputTokens: 400,
              outputTokens: 250,
              reasoningOutputTokens: 100,
              totalTokens: 1250,
              hasInferredPricing: false
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
      hasAnyCodexData: true
    })

    const usage = await store.getAutomationRunUsage({
      worktreeId,
      terminalSessionId: 'tab-1',
      startedAt: new Date('2026-04-10T14:59:00.000Z').getTime(),
      completedAt: new Date('2026-04-10T15:06:00.000Z').getTime()
    })

    expect(usage.status).toBe('known')
    expect(usage.providerSessionId).toBe('session-1')
    expect(usage.cacheReadTokens).toBe(400)
    expect(usage.reasoningOutputTokens).toBe(100)
    expect(usage.estimatedCostUsd).toBeCloseTo(0.0033)
  })

  it('persists scan results, fingerprints worktrees, and skips fresh unchanged refreshes', async () => {
    const sessions: CodexUsagePersistedState['sessions'] = [
      {
        sessionId: 'session-scan',
        firstTimestamp: '2026-04-10T10:00:00.000Z',
        lastTimestamp: '2026-04-10T10:05:00.000Z',
        primaryModel: 'gpt-5',
        hasMixedModels: false,
        primaryProjectLabel: 'Repo',
        hasMixedLocations: false,
        primaryWorktreeId: 'wt-1',
        primaryRepoId: 'repo-1',
        eventCount: 1,
        totalInputTokens: 10,
        totalCachedInputTokens: 2,
        totalOutputTokens: 5,
        totalReasoningOutputTokens: 1,
        totalTokens: 15,
        hasInferredPricing: false,
        locationBreakdown: [
          {
            locationKey: 'worktree:wt-1',
            projectLabel: 'Repo',
            repoId: 'repo-1',
            worktreeId: 'wt-1',
            eventCount: 1,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 5,
            reasoningOutputTokens: 1,
            totalTokens: 15,
            hasInferredPricing: false
          }
        ],
        modelBreakdown: [
          {
            modelKey: 'gpt-5',
            modelLabel: 'gpt-5',
            eventCount: 1,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 5,
            reasoningOutputTokens: 1,
            totalTokens: 15,
            hasInferredPricing: false
          }
        ],
        locationModelBreakdown: [
          {
            locationKey: 'worktree:wt-1',
            modelKey: 'gpt-5',
            modelLabel: 'gpt-5',
            repoId: 'repo-1',
            worktreeId: 'wt-1',
            eventCount: 1,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 5,
            reasoningOutputTokens: 1,
            totalTokens: 15,
            hasInferredPricing: false
          }
        ]
      }
    ]
    const dailyAggregates: CodexUsagePersistedState['dailyAggregates'] = [
      {
        day: '2026-04-10',
        model: 'gpt-5',
        projectKey: 'worktree:wt-1',
        projectLabel: 'Repo',
        repoId: 'repo-1',
        worktreeId: 'wt-1',
        eventCount: 1,
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 1,
        totalTokens: 15,
        hasInferredPricing: false
      }
    ]
    scannerMocks.scanCodexUsageFiles.mockResolvedValue({
      processedFiles: [{ filePath: '/tmp/codex.jsonl', mtimeMs: 1, size: 10 }],
      sessions,
      dailyAggregates
    })
    const backingStore = {
      getRepos: () => [{ id: 'repo-1', path: '/repo', displayName: 'Repo' }],
      getWorktreeMeta: () => undefined
    }
    const store = new CodexUsageStore(backingStore as never)

    await expect(store.setEnabled(true)).resolves.toMatchObject({ enabled: true })
    await expect(store.refresh()).resolves.toMatchObject({
      enabled: true,
      lastScanStartedAt: Date.now(),
      lastScanCompletedAt: Date.now(),
      lastScanError: null,
      hasAnyCodexData: true
    })
    expect(scannerMocks.scanCodexUsageFiles).toHaveBeenCalledWith(
      [{ repoId: 'repo-1', worktreeId: 'wt-1', path: '/repo' }],
      []
    )

    await store.refresh()
    expect(scannerMocks.scanCodexUsageFiles).toHaveBeenCalledTimes(1)
    await expect(store.getDaily('orca', '30d')).resolves.toEqual([
      {
        day: '2026-04-10',
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 1,
        totalTokens: 15
      }
    ])
  })

  it('rescans fresh data when worktree fingerprints change and records scan errors', async () => {
    scannerMocks.scanCodexUsageFiles
      .mockResolvedValueOnce({ processedFiles: [], sessions: [], dailyAggregates: [] })
      .mockRejectedValueOnce(new Error('codex scan failed'))
    const repos = [{ id: 'repo-1', path: '/repo', displayName: 'Repo' }]
    const backingStore = {
      getRepos: () => repos,
      getWorktreeMeta: vi.fn(() => undefined)
    }
    const store = new CodexUsageStore(backingStore as never)
    await store.setEnabled(true)
    await store.refresh(true)

    scannerMocks.createWorktreeRefs.mockReturnValue([
      { repoId: 'repo-1', worktreeId: 'wt-2', path: '/repo-two' }
    ])
    usageMetadataMocks.loadKnownUsageWorktreesByRepo.mockReturnValue(
      new Map([['repo-1', [{ worktreeId: 'wt-2', path: '/repo-two', displayName: 'Repo Two' }]]])
    )
    await store.refresh(false)

    expect(scannerMocks.scanCodexUsageFiles).toHaveBeenCalledTimes(2)
    expect(store.getScanState()).toMatchObject({
      isScanning: false,
      lastScanError: 'codex scan failed'
    })
  })
})
