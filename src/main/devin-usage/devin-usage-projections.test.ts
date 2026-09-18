import { describe, expect, it } from 'vitest'
import { devinUsageAggregation } from './devin-usage-aggregation'
import {
  buildDevinBreakdown,
  buildDevinDaily,
  buildDevinRecentSessions,
  buildDevinSummary
} from './devin-usage-projections'
import type { DevinUsageAttributedEvent, DevinUsagePersistedState } from './types'

function event(overrides: Partial<DevinUsageAttributedEvent> = {}): DevinUsageAttributedEvent {
  return {
    sessionId: 's1',
    timestamp: '2026-09-18T10:00:00Z',
    day: '2026-09-18',
    model: 'model-a',
    cwd: '/repo/a',
    projectKey: 'worktree:a',
    projectLabel: 'Same name',
    repoId: 'repo-a',
    worktreeId: 'a',
    inputTokens: 10,
    cachedInputTokens: 3,
    outputTokens: 5,
    reasoningOutputTokens: 2,
    totalTokens: 15,
    estimatedCostUsd: null,
    ...overrides
  }
}

function state(events: DevinUsageAttributedEvent[]): DevinUsagePersistedState {
  return {
    schemaVersion: 1,
    worktreeFingerprint: null,
    processedFiles: [],
    ...devinUsageAggregation.aggregate(events),
    scanState: {
      enabled: true,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    }
  }
}

const mixedLocations = () =>
  state([
    event(),
    event({
      model: 'model-b',
      cwd: '/outside',
      projectKey: 'cwd:/outside',
      projectLabel: 'Outside',
      repoId: null,
      worktreeId: null
    }),
    event({ sessionId: 's2', model: 'model-b' }),
    event({ sessionId: 's2', model: 'model-b', timestamp: '2026-09-18T10:01:00Z' })
  ])

describe('Devin usage projections', () => {
  it('does not pool distinct projects that have the same display name', () => {
    const snapshot = state([
      event({ totalTokens: 15 }),
      event({ sessionId: 's2', projectKey: 'worktree:b', worktreeId: 'b', totalTokens: 15 }),
      event({
        sessionId: 's3',
        projectKey: 'worktree:c',
        worktreeId: 'c',
        projectLabel: 'Winner',
        totalTokens: 20
      })
    ])
    expect(buildDevinSummary(snapshot, 'all', 'all').topProject).toBe('Winner')
    expect(buildDevinBreakdown(snapshot, 'all', 'all', 'project')).toHaveLength(3)
  })

  it('counts each scoped model once per session, excluding models used only elsewhere', () => {
    expect(buildDevinBreakdown(mixedLocations(), 'orca', 'all', 'model')).toEqual([
      expect.objectContaining({ key: 'model-b', sessions: 1, events: 2 }),
      expect.objectContaining({ key: 'model-a', sessions: 1, events: 1 })
    ])
    expect(buildDevinBreakdown(mixedLocations(), 'all', 'all', 'model')[0]).toMatchObject({
      key: 'model-b',
      sessions: 2,
      events: 3
    })
  })

  it('labels recent sessions using only models in the selected scope', () => {
    expect(
      buildDevinRecentSessions(mixedLocations(), 'orca', 'all', 10).find(
        (row) => row.sessionId === 's1'
      )
    ).toMatchObject({ model: 'model-a', totalTokens: 15 })
    expect(
      buildDevinRecentSessions(mixedLocations(), 'all', 'all', 10).find(
        (row) => row.sessionId === 's1'
      )
    ).toMatchObject({ model: 'Mixed models', totalTokens: 30 })
  })

  it('preserves reasoning tokens throughout the scoped projections', () => {
    const snapshot = mixedLocations()
    expect(buildDevinSummary(snapshot, 'orca', 'all').reasoningOutputTokens).toBe(6)
    expect(buildDevinDaily(snapshot, 'orca', 'all')[0].reasoningOutputTokens).toBe(6)
    expect(buildDevinBreakdown(snapshot, 'orca', 'all', 'model')[0].reasoningOutputTokens).toBe(4)
    expect(buildDevinBreakdown(snapshot, 'orca', 'all', 'project')[0].reasoningOutputTokens).toBe(6)
    expect(
      buildDevinRecentSessions(snapshot, 'orca', 'all', 10).find((row) => row.sessionId === 's1')
        ?.reasoningOutputTokens
    ).toBe(2)
  })
})
