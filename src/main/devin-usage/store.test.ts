import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getPathMock } = vi.hoisted(() => ({ getPathMock: vi.fn() }))
vi.mock('electron', () => ({ app: { getPath: getPathMock } }))
vi.mock('../usage/usage-scan-worker-spawn', () => ({ scanDevinUsageFilesViaWorker: vi.fn() }))

import { DEVIN_USAGE_SCHEMA_VERSION } from './devin-usage-provider'
import { DevinUsageStore, initDevinUsagePath, normalizeDevinUsageState } from './store'

describe('DevinUsageStore persisted state', () => {
  let userData: string

  beforeEach(() => {
    userData = mkdtempSync(join(tmpdir(), 'orca-devin-store-'))
    getPathMock.mockReturnValue(userData)
    initDevinUsagePath()
  })

  afterEach(() => rmSync(userData, { recursive: true, force: true }))

  it('drops malformed projections without losing the enabled preference', () => {
    const state = normalizeDevinUsageState({
      schemaVersion: DEVIN_USAGE_SCHEMA_VERSION,
      scanState: { enabled: true },
      sessions: [{ locationBreakdown: null, modelBreakdown: [], locationModelBreakdown: [] }],
      dailyAggregates: [{ day: 'bad' }],
      processedFiles: []
    })
    expect(state.scanState.enabled).toBe(true)
    expect(state.sessions).toEqual([])
    expect(state.dailyAggregates).toEqual([])
  })

  it('migrates an old schema by clearing aggregates while preserving opt-in state', () => {
    writeFileSync(
      join(userData, 'orca-devin-usage.json'),
      JSON.stringify({
        schemaVersion: 1,
        scanState: { enabled: true },
        sessions: [{ locationBreakdown: [], modelBreakdown: [], locationModelBreakdown: [] }]
      })
    )
    const store = new DevinUsageStore({ getRepos: () => [], getAllWorktreeMeta: () => ({}) })
    expect(store.getScanState().enabled).toBe(true)
    expect(store.getScanState().hasAnyDevinData).toBe(false)
  })
})
