/* eslint-disable max-lines -- Why: scanner coverage keeps path fixtures and
   parser edge cases together so filesystem setup is not duplicated. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import {
  attributeCodexUsageEvent,
  createWorktreeRefs,
  getDefaultWorktreeLabel,
  getSessionProjectLabel,
  parseCodexUsageFile,
  parseCodexUsageRecord,
  scanCodexUsageFiles
} from './scanner'
import type { CodexUsagePersistedFile } from './types'

let tempRoot: string
let originalCodexHome: string | undefined

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'orca-codex-usage-scanner-'))
  originalCodexHome = process.env.CODEX_HOME
})

afterEach(() => {
  if (originalCodexHome === undefined) {
    delete process.env.CODEX_HOME
  } else {
    process.env.CODEX_HOME = originalCodexHome
  }
  rmSync(tempRoot, { recursive: true, force: true })
})

function writeJsonl(filePath: string, records: unknown[]): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, records.map((record) => JSON.stringify(record)).join('\n'))
}

function tokenCountRecord(
  timestamp: string,
  usage: {
    input: number
    cached: number
    output: number
    reasoning: number
    total?: number
  },
  extraPayload: Record<string, unknown> = {}
): unknown {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      ...extraPayload,
      info: {
        total_token_usage: {
          input_tokens: usage.input,
          cached_input_tokens: usage.cached,
          output_tokens: usage.output,
          reasoning_output_tokens: usage.reasoning,
          total_tokens: usage.total ?? usage.input + usage.output
        }
      }
    }
  }
}

describe('parseCodexUsageRecord', () => {
  it('uses token totals only as a duplicate baseline', () => {
    const context = {
      sessionId: 'session-1',
      sessionCwd: null,
      currentCwd: null,
      currentModel: null,
      previousTotals: null
    }

    expect(
      parseCodexUsageRecord(
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'session-1', cwd: '/workspace/repo' }
        }),
        context
      )
    ).toBeNull()

    expect(
      parseCodexUsageRecord(
        JSON.stringify({
          type: 'turn_context',
          payload: { cwd: '/workspace/repo/packages/app', model: 'gpt-5.2-codex' }
        }),
        context
      )
    ).toBeNull()

    const first = parseCodexUsageRecord(
      JSON.stringify({
        timestamp: '2026-04-09T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 250,
              reasoning_output_tokens: 100,
              total_tokens: 1250
            },
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 250,
              reasoning_output_tokens: 100,
              total_tokens: 1250
            }
          }
        }
      }),
      context
    )

    const duplicate = parseCodexUsageRecord(
      JSON.stringify({
        timestamp: '2026-04-09T10:00:01.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 250,
              reasoning_output_tokens: 100,
              total_tokens: 1250
            },
            last_token_usage: {
              input_tokens: 1000,
              cached_input_tokens: 400,
              output_tokens: 250,
              reasoning_output_tokens: 100,
              total_tokens: 1250
            }
          }
        }
      }),
      context
    )

    expect(first).toEqual({
      sessionId: 'session-1',
      timestamp: '2026-04-09T10:00:00.000Z',
      cwd: '/workspace/repo/packages/app',
      model: 'gpt-5.2-codex',
      hasInferredPricing: false,
      inputTokens: 1000,
      cachedInputTokens: 400,
      outputTokens: 250,
      reasoningOutputTokens: 100,
      totalTokens: 1250
    })
    expect(duplicate).toBeNull()
  })

  it('preserves unknown model metadata instead of assigning fallback pricing', () => {
    const context = {
      sessionId: 'session-1',
      sessionCwd: '/workspace/repo',
      currentCwd: '/workspace/repo',
      currentModel: null,
      previousTotals: null
    }

    const parsed = parseCodexUsageRecord(
      JSON.stringify({
        timestamp: '2026-04-09T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: {
              input_tokens: 120,
              cached_input_tokens: 20,
              output_tokens: 50,
              reasoning_output_tokens: 10,
              total_tokens: 170
            }
          }
        }
      }),
      context
    )

    expect(parsed?.model).toBeNull()
    expect(parsed?.hasInferredPricing).toBe(true)
  })

  it('uses last token usage for the first resumed-session event', () => {
    const context = {
      sessionId: 'session-1',
      sessionCwd: '/workspace/repo',
      currentCwd: '/workspace/repo',
      currentModel: 'gpt-5.5',
      previousTotals: null
    }

    const parsed = parseCodexUsageRecord(
      JSON.stringify({
        timestamp: '2026-04-09T10:00:00.000Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: {
              input_tokens: 50_000,
              cached_input_tokens: 40_000,
              output_tokens: 5_000,
              reasoning_output_tokens: 1_000,
              total_tokens: 55_000
            },
            last_token_usage: {
              input_tokens: 2_000,
              cached_input_tokens: 1_500,
              output_tokens: 500,
              reasoning_output_tokens: 100,
              total_tokens: 2_500
            }
          }
        }
      }),
      context
    )

    expect(parsed).toMatchObject({
      inputTokens: 2_000,
      cachedInputTokens: 1_500,
      outputTokens: 500,
      reasoningOutputTokens: 100,
      totalTokens: 2_500
    })
  })
})

describe('attributeCodexUsageEvent', () => {
  it('attributes nested cwd paths to the nearest containing worktree', async () => {
    const attributed = await attributeCodexUsageEvent(
      {
        sessionId: 'session-1',
        timestamp: '2026-04-09T10:00:00.000Z',
        cwd: '/workspace/repo/app2/subdir',
        model: 'gpt-5.2-codex',
        hasInferredPricing: false,
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 25,
        reasoningOutputTokens: 10,
        totalTokens: 125
      },
      [
        {
          repoId: 'repo-1',
          worktreeId: 'repo-1::/workspace/repo/app',
          path: '/workspace/repo/app',
          displayName: 'App',
          canonicalPath: '/workspace/repo/app'
        },
        {
          repoId: 'repo-2',
          worktreeId: 'repo-2::/workspace/repo/app2',
          path: '/workspace/repo/app2',
          displayName: 'App 2',
          canonicalPath: '/workspace/repo/app2'
        }
      ]
    )

    expect(attributed?.projectKey).toBe('worktree:repo-2::/workspace/repo/app2')
    expect(attributed?.projectLabel).toBe('App 2')
    expect(attributed?.worktreeId).toBe('repo-2::/workspace/repo/app2')
  })

  it('does not treat different Windows drives as containing paths', async () => {
    const attributed = await attributeCodexUsageEvent(
      {
        sessionId: 'session-1',
        timestamp: '2026-04-09T10:00:00.000Z',
        cwd: 'D:\\other\\repo',
        model: 'gpt-5.2-codex',
        hasInferredPricing: false,
        inputTokens: 100,
        cachedInputTokens: 10,
        outputTokens: 25,
        reasoningOutputTokens: 10,
        totalTokens: 125
      },
      [
        {
          repoId: 'repo-1',
          worktreeId: 'repo-1::C:\\repo',
          path: 'C:\\repo',
          displayName: 'Repo',
          canonicalPath: 'C:\\repo'
        }
      ]
    )

    expect(attributed?.projectKey).toBe('cwd:d:/other/repo')
    expect(attributed?.worktreeId).toBeNull()
  })
})

describe('parseCodexUsageFile', () => {
  it('aggregates sessions across mixed models and locations', async () => {
    const repoPath = join(tempRoot, 'repo')
    const appPath = join(repoPath, 'app')
    const docsPath = join(repoPath, 'docs')
    const filePath = join(tempRoot, 'session-agg.jsonl')
    writeJsonl(filePath, [
      { type: 'session_meta', payload: { id: 'session-agg', cwd: repoPath } },
      { type: 'turn_context', payload: { cwd: appPath, model: 'gpt-5.2-codex' } },
      tokenCountRecord('2026-04-09T12:00:00.000Z', {
        input: 100,
        cached: 10,
        output: 40,
        reasoning: 5,
        total: 140
      }),
      {
        type: 'turn_context',
        payload: { cwd: docsPath, metadata: { model: 'gpt-5.3-codex' } }
      },
      tokenCountRecord(
        '2026-04-09T12:05:00.000Z',
        {
          input: 160,
          cached: 25,
          output: 70,
          reasoning: 10,
          total: 230
        },
        { info: { metadata: { model: 'ignored' } } }
      )
    ])

    const processed = await parseCodexUsageFile(filePath, [
      {
        repoId: 'repo-1',
        worktreeId: 'wt-app',
        path: appPath,
        displayName: 'App',
        canonicalPath: appPath
      }
    ])

    expect(processed.path).toBe(filePath)
    expect(processed.sessions).toHaveLength(1)
    expect(processed.sessions[0]).toMatchObject({
      sessionId: 'session-agg',
      eventCount: 2,
      totalInputTokens: 160,
      totalCachedInputTokens: 25,
      totalOutputTokens: 70,
      totalReasoningOutputTokens: 10,
      totalTokens: 230,
      primaryModel: 'Mixed models',
      hasMixedModels: true,
      primaryProjectLabel: 'Multiple locations',
      hasMixedLocations: true
    })
    expect(processed.sessions[0].locationBreakdown).toEqual([
      expect.objectContaining({
        locationKey: 'worktree:wt-app',
        projectLabel: 'App',
        totalTokens: 140
      }),
      expect.objectContaining({
        locationKey: `cwd:${docsPath}`,
        projectLabel: 'repo/docs',
        totalTokens: 90
      })
    ])
    expect(processed.sessions[0].modelBreakdown).toEqual([
      expect.objectContaining({ modelKey: 'gpt-5.2-codex', totalTokens: 140 }),
      expect.objectContaining({ modelKey: 'gpt-5.3-codex', totalTokens: 90 })
    ])
    expect(processed.dailyAggregates).toEqual([
      expect.objectContaining({
        day: '2026-04-09',
        model: 'gpt-5.2-codex',
        projectLabel: 'App',
        totalTokens: 140
      }),
      expect.objectContaining({
        day: '2026-04-09',
        model: 'gpt-5.3-codex',
        projectLabel: 'repo/docs',
        totalTokens: 90
      })
    ])
  })
})

describe('scanCodexUsageFiles', () => {
  it('reuses unchanged processed files and parses changed files from CODEX_HOME', async () => {
    const codexHome = join(tempRoot, 'codex-home')
    process.env.CODEX_HOME = codexHome
    const sessionsDir = join(codexHome, 'sessions')
    const reusedPath = join(sessionsDir, '2026', '04', 'reused.jsonl')
    const parsedPath = join(sessionsDir, '2026', '04', 'parsed.jsonl')
    const repoPath = join(tempRoot, 'repo')

    writeJsonl(reusedPath, [{ invalid: 'would not parse if reused' }])
    writeJsonl(parsedPath, [
      { type: 'session_meta', payload: { id: 'parsed-session', cwd: repoPath } },
      { type: 'turn_context', payload: { cwd: repoPath, model: 'gpt-5.4-codex' } },
      tokenCountRecord('2026-04-10T12:00:00.000Z', {
        input: 50,
        cached: 5,
        output: 20,
        reasoning: 4,
        total: 70
      })
    ])

    const reusedStat = statSync(reusedPath)
    const previous: CodexUsagePersistedFile = {
      path: reusedPath,
      mtimeMs: reusedStat.mtimeMs,
      size: reusedStat.size,
      sessions: [
        {
          sessionId: 'reused-session',
          firstTimestamp: '2026-04-08T12:00:00.000Z',
          lastTimestamp: '2026-04-08T12:00:00.000Z',
          primaryModel: 'gpt-5.2-codex',
          hasMixedModels: false,
          primaryProjectLabel: 'Previous',
          hasMixedLocations: false,
          primaryWorktreeId: null,
          primaryRepoId: null,
          eventCount: 1,
          totalInputTokens: 10,
          totalCachedInputTokens: 0,
          totalOutputTokens: 5,
          totalReasoningOutputTokens: 0,
          totalTokens: 15,
          hasInferredPricing: false,
          locationBreakdown: [
            {
              locationKey: 'cwd:/previous',
              projectLabel: 'Previous',
              repoId: null,
              worktreeId: null,
              eventCount: 1,
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              reasoningOutputTokens: 0,
              totalTokens: 15,
              hasInferredPricing: false
            }
          ],
          modelBreakdown: [
            {
              modelKey: 'gpt-5.2-codex',
              modelLabel: 'gpt-5.2-codex',
              hasInferredPricing: false,
              eventCount: 1,
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              reasoningOutputTokens: 0,
              totalTokens: 15
            }
          ],
          locationModelBreakdown: [
            {
              locationKey: 'cwd:/previous',
              modelKey: 'gpt-5.2-codex',
              modelLabel: 'gpt-5.2-codex',
              repoId: null,
              worktreeId: null,
              eventCount: 1,
              inputTokens: 10,
              cachedInputTokens: 0,
              outputTokens: 5,
              reasoningOutputTokens: 0,
              totalTokens: 15,
              hasInferredPricing: false
            }
          ]
        }
      ],
      dailyAggregates: [
        {
          day: '2026-04-08',
          model: 'gpt-5.2-codex',
          projectKey: 'cwd:/previous',
          projectLabel: 'Previous',
          repoId: null,
          worktreeId: null,
          eventCount: 1,
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningOutputTokens: 0,
          totalTokens: 15,
          hasInferredPricing: false
        }
      ]
    }

    const result = await scanCodexUsageFiles(
      [
        {
          repoId: 'repo-1',
          worktreeId: 'wt-repo',
          path: repoPath,
          displayName: 'Repo'
        }
      ],
      [previous]
    )

    expect(result.processedFiles.map((file) => file.path).sort()).toEqual(
      [parsedPath, reusedPath].sort()
    )
    expect(result.sessions.map((session) => session.sessionId)).toEqual([
      'parsed-session',
      'reused-session'
    ])
    expect(result.sessions.find((session) => session.sessionId === 'parsed-session')).toMatchObject(
      {
        primaryProjectLabel: 'Repo',
        primaryWorktreeId: 'wt-repo',
        totalTokens: 70
      }
    )
    expect(result.dailyAggregates).toEqual([
      expect.objectContaining({ day: '2026-04-08', projectLabel: 'Previous', totalTokens: 15 }),
      expect.objectContaining({ day: '2026-04-10', projectLabel: 'Repo', totalTokens: 70 })
    ])
  })
})

describe('scanner display helpers', () => {
  it('creates worktree refs and labels session project breakdowns', () => {
    expect(
      createWorktreeRefs(
        [
          {
            id: 'repo-1',
            path: '/workspace/repo',
            displayName: 'Repo',
            badgeColor: '#fff',
            addedAt: 1
          }
        ],
        new Map([
          ['repo-1', [{ path: '/workspace/repo/app', worktreeId: 'wt-app', displayName: 'App' }]]
        ])
      )
    ).toEqual([
      {
        repoId: 'repo-1',
        worktreeId: 'wt-app',
        path: '/workspace/repo/app',
        displayName: 'App'
      }
    ])
    expect(getDefaultWorktreeLabel('/workspace/repo/app')).toBe('app')
    expect(getSessionProjectLabel([])).toBe('Unknown location')
    expect(getSessionProjectLabel([{ projectLabel: 'App' } as never])).toBe('App')
    expect(
      getSessionProjectLabel([{ projectLabel: 'App' } as never, { projectLabel: 'Docs' } as never])
    ).toBe('Multiple locations')
  })
})
