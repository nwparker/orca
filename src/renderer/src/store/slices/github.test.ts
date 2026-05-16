/* eslint-disable max-lines -- Why: colocating the PR/issue cache, work-item
envelope, and IssueSourceIndicator suppression tests in one file keeps the
GitHub slice's cross-cutting invariants verifiable in one place. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createGitHubSlice, projectViewCacheKey } from './github'
import type { AppState } from '../types'
import type { PRInfo } from '../../../../shared/types'
import type { GitHubProjectTable } from '../../../../shared/github-project-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const mockApi = {
  gh: {
    prForBranch: vi.fn().mockResolvedValue(null),
    issue: vi.fn().mockResolvedValue(null),
    prChecks: vi.fn().mockResolvedValue([]),
    prComments: vi.fn().mockResolvedValue([]),
    resolveReviewThread: vi.fn().mockResolvedValue(true),
    listWorkItems: vi.fn(),
    countWorkItems: vi.fn(),
    getProjectViewTable: vi.fn(),
    updateProjectItemField: vi.fn(),
    clearProjectItemField: vi.fn(),
    updateIssueBySlug: vi.fn(),
    updatePullRequestBySlug: vi.fn(),
    updateIssueTypeBySlug: vi.fn()
  },
  runtimeEnvironments: {
    call: runtimeEnvironmentTransportCall
  },
  cache: {
    getGitHub: vi.fn().mockResolvedValue(null),
    setGitHub: vi.fn().mockResolvedValue(undefined)
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function resetRemoteRuntimeMocks() {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
}

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createGitHubSlice(...a)
      }) as AppState
  )
}

function makePR(overrides: Partial<PRInfo> = {}): PRInfo {
  return {
    number: 12,
    title: 'Test PR',
    state: 'open',
    url: 'https://example.com/pr/12',
    checksStatus: 'pending',
    updatedAt: '2026-03-28T00:00:00Z',
    mergeable: 'UNKNOWN',
    headSha: 'head-oid',
    ...overrides
  }
}

function makeProjectTable(): GitHubProjectTable {
  return {
    project: {
      id: 'project-1',
      owner: 'acme',
      ownerType: 'organization',
      number: 7,
      title: 'Roadmap',
      url: 'https://github.com/orgs/acme/projects/7'
    },
    selectedView: {
      id: 'view-1',
      number: 1,
      name: 'Table',
      layout: 'TABLE_LAYOUT',
      filter: '',
      fields: [
        {
          kind: 'single-select',
          id: 'field-status',
          name: 'Status',
          dataType: 'SINGLE_SELECT',
          options: [{ id: 'todo', name: 'Todo', color: 'GRAY' }]
        },
        {
          kind: 'iteration',
          id: 'field-iteration',
          name: 'Iteration',
          dataType: 'ITERATION',
          iterations: [
            {
              id: 'sprint-1',
              title: 'Sprint 1',
              startDate: '2026-01-01',
              duration: 14,
              completed: false
            }
          ]
        }
      ],
      groupByFields: [],
      sortByFields: []
    },
    rows: [
      {
        id: 'row-issue',
        itemType: 'ISSUE',
        content: {
          number: 42,
          title: 'Issue row',
          body: 'Body',
          url: 'https://github.com/acme/widgets/issues/42',
          state: 'OPEN',
          stateReason: null,
          isDraft: null,
          repository: 'acme/widgets',
          assignees: [{ login: 'mona', name: null, avatarUrl: null }],
          labels: [{ name: 'bug', color: 'red' }],
          parentIssue: null,
          issueType: null
        },
        fieldValuesByFieldId: {
          'field-status': {
            kind: 'single-select',
            fieldId: 'field-status',
            optionId: 'old',
            name: 'Old',
            color: 'RED'
          }
        },
        updatedAt: '2026-01-01T00:00:00Z',
        position: 0
      },
      {
        id: 'row-pr',
        itemType: 'PULL_REQUEST',
        content: {
          number: 43,
          title: 'PR row',
          body: 'Body',
          url: 'https://github.com/acme/widgets/pull/43',
          state: 'OPEN',
          stateReason: null,
          isDraft: false,
          repository: 'acme/widgets',
          assignees: [],
          labels: [],
          parentIssue: null,
          issueType: null
        },
        fieldValuesByFieldId: {},
        updatedAt: '2026-01-02T00:00:00Z',
        position: 1
      }
    ],
    totalCount: 2,
    parentFieldDropped: false
  }
}

describe('createGitHubSlice.fetchPRChecks', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prChecks.mockResolvedValue([])
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('updates the matching PR cache entry with derived check status', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      }
    })

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null },
      { name: 'lint', status: 'completed', conclusion: 'success', url: null }
    ])

    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, { force: true, repoId })

    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('success')
  })

  it('marks the PR cache entry as failure when any check fails', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      }
    })

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null },
      { name: 'integration', status: 'completed', conclusion: 'failure', url: null }
    ])

    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, { force: true, repoId })

    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('failure')
  })

  it('normalizes refs/heads branch names before updating PR cache status', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      }
    })

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])

    await store
      .getState()
      .fetchPRChecks(repoPath, 12, `refs/heads/${branch}`, undefined, { force: true, repoId })

    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('success')
  })

  it('persists the updated PR cache after deriving a new checks status', async () => {
    vi.useFakeTimers()

    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      }
    })

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])

    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, { force: true, repoId })
    await vi.advanceTimersByTimeAsync(1000)

    expect(mockApi.cache.setGitHub).toHaveBeenCalledWith({
      cache: {
        pr: store.getState().prCache,
        issue: store.getState().issueCache
      }
    })
  })

  it('syncs PR status from a fresh checks cache hit without refetching', async () => {
    vi.useFakeTimers()

    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`
    const checksCacheKey = `${repoId}::pr-checks::12`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ checksStatus: 'pending' }),
          fetchedAt: 1
        }
      },
      checksCache: {
        [checksCacheKey]: {
          data: [{ name: 'build', status: 'completed', conclusion: 'success', url: null }],
          fetchedAt: Date.now()
        }
      }
    })

    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, { repoId })
    await vi.advanceTimersByTimeAsync(1000)

    expect(mockApi.gh.prChecks).not.toHaveBeenCalled()
    expect(store.getState().prCache[prCacheKey]?.data?.checksStatus).toBe('success')
    expect(mockApi.cache.setGitHub).toHaveBeenCalledWith({
      cache: {
        pr: store.getState().prCache,
        issue: store.getState().issueCache
      }
    })
  })

  it('passes the cached PR head SHA to the checks IPC request', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const prCacheKey = `${repoId}::${branch}`

    store.setState({
      prCache: {
        [prCacheKey]: {
          data: makePR({ headSha: 'abc123head' }),
          fetchedAt: 1
        }
      }
    })

    await store
      .getState()
      .fetchPRChecks(repoPath, 12, branch, 'abc123head', { force: true, repoId })

    expect(mockApi.gh.prChecks).toHaveBeenCalledWith({
      repoPath,
      repoId,
      prNumber: 12,
      headSha: 'abc123head',
      noCache: true
    })
  })

  it('updates repo-scoped PR cache entry instead of repoPath fallback key', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const repoId = 'repo-id'
    const branch = 'feature/test'
    const repoScopedKey = `${repoId}::${branch}`
    const pathScopedKey = `${repoPath}::${branch}`

    store.setState({
      prCache: {
        [repoScopedKey]: { data: makePR({ checksStatus: 'pending' }), fetchedAt: 1 },
        [pathScopedKey]: { data: makePR({ checksStatus: 'pending' }), fetchedAt: 1 }
      }
    })

    mockApi.gh.prChecks.mockResolvedValue([
      { name: 'build', status: 'completed', conclusion: 'success', url: null }
    ])

    await store.getState().fetchPRChecks(repoPath, 12, branch, undefined, { force: true, repoId })

    expect(store.getState().prCache[repoScopedKey]?.data?.checksStatus).toBe('success')
    expect(store.getState().prCache[pathScopedKey]?.data?.checksStatus).toBe('pending')
  })
})

describe('createGitHubSlice.fetchPRForBranch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.prForBranch.mockResolvedValue(null)
  })

  it('lets a forced refresh bypass a non-forced inflight request and keeps the newer result', async () => {
    const store = createTestStore()
    const repoPath = '/repo'
    const branch = 'feature/test'
    const prCacheKey = `${repoPath}::${branch}`

    let resolveInitial: ((value: null) => void) | undefined
    const initialRequest = new Promise<null>((resolve) => {
      resolveInitial = resolve
    })

    mockApi.gh.prForBranch
      .mockReturnValueOnce(initialRequest)
      .mockResolvedValueOnce(makePR({ number: 99, title: 'Forced refresh PR' }))

    const initialFetch = store.getState().fetchPRForBranch(repoPath, branch)
    const forcedFetch = store.getState().fetchPRForBranch(repoPath, branch, { force: true })

    await expect(forcedFetch).resolves.toMatchObject({ number: 99, title: 'Forced refresh PR' })
    expect(mockApi.gh.prForBranch).toHaveBeenCalledTimes(2)
    expect(store.getState().prCache[prCacheKey]?.data).toMatchObject({ number: 99 })

    resolveInitial?.(null)
    await expect(initialFetch).resolves.toBeNull()

    expect(store.getState().prCache[prCacheKey]?.data).toMatchObject({ number: 99 })
  })
})

describe('createGitHubSlice.fetchWorkItems source/error envelope', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { items: [], sources: { issues: null, prs: null, upstreamCandidate: null } },
      _meta: { runtimeId: 'remote-runtime' }
    })
  })

  it('stores resolved sources on the cache entry for the indicator to read', async () => {
    // Why: parent design doc §1 suppression rule — the Tasks header indicator
    // consults `sources.issues` vs `sources.prs` on the cache entry. This is
    // the round-trip through fetchWorkItems that populates those fields.
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'fork', repo: 'r' } }
    })

    await store.getState().fetchWorkItems('repo-id', '/repo', 24, '')

    const result = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(result.sources).toEqual({
      issues: { owner: 'up', repo: 'r' },
      prs: { owner: 'fork', repo: 'r' }
    })
    expect(result.error).toBeNull()
  })

  it('stamps the issues-side ClassifiedError with its source slug for banner copy', async () => {
    // Why: parent design doc §2 partial-failure rule — when the issue fetch
    // returns a 403 but the PR fetch succeeds, the cache entry carries the
    // successful items AND the error for the failing side so the banner +
    // list render together. The error's `source` is pinned to the issues
    // slug so the banner copy stays correct even if the cache entry later
    // receives new data from another read.
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'fork', repo: 'r' } },
      errors: { issues: { type: 'permission_denied', message: 'no access' } }
    })

    await store.getState().fetchWorkItems('repo-id', '/repo', 24, '')

    const result = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(result.error).toMatchObject({
      type: 'permission_denied',
      message: 'no access',
      source: { owner: 'up', repo: 'r' }
    })
  })

  it('force-retry invalidates a still-failing in-flight request instead of deduping onto it', async () => {
    // Why: parent design doc §2 acceptance criterion 4 — the [Retry] button
    // must re-invoke the fetch with force=true and clear the banner on
    // success. That only works when force=true does not silently dedupe onto
    // a still-failing non-forcing request.
    const store = createTestStore()
    let resolveFailing: (v: unknown) => void = () => {}
    const failingRequest = new Promise((resolve) => {
      resolveFailing = resolve
    })
    mockApi.gh.listWorkItems.mockReturnValueOnce(failingRequest).mockResolvedValueOnce({
      items: [],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'fork', repo: 'r' } }
    })

    const initialFetch = store.getState().fetchWorkItems('repo-id', '/repo', 24, '')
    const forcedFetch = store.getState().fetchWorkItems('repo-id', '/repo', 24, '', { force: true })

    // Let the initial request settle with an error so the force path runs.
    resolveFailing({
      items: [],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'fork', repo: 'r' } },
      errors: { issues: { type: 'permission_denied', message: 'no access' } }
    })
    await initialFetch.catch(() => {})
    await forcedFetch

    expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(2)
    const after = store.getState().getWorkItemsSourcesAndError('repo-id', 24, '')
    expect(after.error).toBeNull()
  })

  it('routes work item fetches through repo-scoped IPC even when a runtime is active', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      repos: [
        {
          id: 'repo-id',
          path: '/server/repo',
          displayName: 'repo',
          badgeColor: 'blue',
          addedAt: 1
        }
      ]
    } as Partial<AppState>)
    mockApi.gh.listWorkItems.mockResolvedValueOnce({
      items: [{ type: 'issue', number: 7, title: 'Server issue', url: 'https://example.test/7' }],
      sources: { issues: { owner: 'up', repo: 'r' }, prs: { owner: 'up', repo: 'r' } }
    })

    await store.getState().fetchWorkItems('repo-id', '/server/repo', 24, '')

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/server/repo',
      repoId: 'repo-id',
      limit: 24,
      query: undefined
    })
    expect(store.getState().workItemsCache['repo-id::24::'].data?.[0]).toMatchObject({
      repoId: 'repo-id',
      number: 7
    })
  })

  it('routes project table fetches through the active runtime environment', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' }
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: {
        ok: true,
        data: {
          project: {
            id: 'project-1',
            owner: 'acme',
            ownerType: 'organization',
            number: 1,
            title: 'Roadmap',
            url: 'https://github.com/orgs/acme/projects/1'
          },
          selectedView: {
            id: 'view-1',
            number: 1,
            name: 'Table',
            layout: 'TABLE_LAYOUT',
            filter: '',
            fields: [],
            groupByFields: [],
            sortByFields: []
          },
          rows: [],
          totalCount: 0,
          parentFieldDropped: false
        }
      },
      _meta: { runtimeId: 'remote-runtime' }
    })

    const result = await store.getState().fetchProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 1,
      viewId: 'view-1'
    })

    expect(result.ok).toBe(true)
    expect(mockApi.gh.getProjectViewTable).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'github.project.viewTable',
      params: {
        owner: 'acme',
        ownerType: 'organization',
        projectNumber: 1,
        viewId: 'view-1'
      },
      timeoutMs: 60_000
    })
  })
})

describe('createGitHubSlice ProjectV2 optimistic cache updates', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    mockApi.gh.updateProjectItemField.mockResolvedValue({ ok: true })
    mockApi.gh.clearProjectItemField.mockResolvedValue({ ok: true })
    mockApi.gh.updateIssueBySlug.mockResolvedValue({ ok: true })
    mockApi.gh.updatePullRequestBySlug.mockResolvedValue({ ok: true })
    mockApi.gh.updateIssueTypeBySlug.mockResolvedValue({ ok: true })
  })

  function seedProject(store: ReturnType<typeof createTestStore>) {
    const table = makeProjectTable()
    const cacheKey = projectViewCacheKey('organization', 'acme', 7, 'view-1')
    store.setState({
      projectViewCache: {
        [cacheKey]: { data: table, fetchedAt: Date.now() }
      }
    })
    return { cacheKey }
  }

  it('optimistically updates and clears project field values', async () => {
    const store = createTestStore()
    const { cacheKey } = seedProject(store)

    await expect(
      store.getState().updateProjectFieldValue(cacheKey, 'row-issue', 'field-status', {
        kind: 'single-select',
        optionId: 'todo'
      })
    ).resolves.toEqual({ ok: true })
    expect(
      store.getState().projectViewCache[cacheKey]?.data?.rows[0].fieldValuesByFieldId[
        'field-status'
      ]
    ).toMatchObject({ optionId: 'todo', name: 'Todo', color: 'GRAY' })
    expect(mockApi.gh.updateProjectItemField).toHaveBeenCalledWith({
      projectId: 'project-1',
      itemId: 'row-issue',
      fieldId: 'field-status',
      value: { kind: 'single-select', optionId: 'todo' }
    })

    await expect(
      store.getState().clearProjectFieldValue(cacheKey, 'row-issue', 'field-status')
    ).resolves.toEqual({ ok: true })
    expect(
      store.getState().projectViewCache[cacheKey]?.data?.rows[0].fieldValuesByFieldId[
        'field-status'
      ]
    ).toBeUndefined()
  })

  it('rolls back optimistic field updates when the mutation fails', async () => {
    const store = createTestStore()
    const { cacheKey } = seedProject(store)
    mockApi.gh.updateProjectItemField.mockResolvedValueOnce({
      ok: false,
      error: { type: 'validation_error', message: 'Nope' }
    })

    await expect(
      store.getState().updateProjectFieldValue(cacheKey, 'row-issue', 'field-status', {
        kind: 'text',
        text: 'bad'
      })
    ).resolves.toMatchObject({ ok: false })
    expect(
      store.getState().projectViewCache[cacheKey]?.data?.rows[0].fieldValuesByFieldId[
        'field-status'
      ]
    ).toMatchObject({ optionId: 'old', name: 'Old' })
  })

  it('patches issues and pull requests through the correct slug endpoints', async () => {
    const store = createTestStore()
    const { cacheKey } = seedProject(store)

    await expect(
      store.getState().patchProjectIssueOrPr(cacheKey, 'row-issue', {
        title: 'Updated issue',
        body: 'Updated body',
        addLabels: ['enhancement'],
        removeLabels: ['bug'],
        addAssignees: ['octo'],
        removeAssignees: ['mona']
      })
    ).resolves.toEqual({ ok: true })
    expect(mockApi.gh.updateIssueBySlug).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      updates: {
        title: 'Updated issue',
        body: 'Updated body',
        addLabels: ['enhancement'],
        removeLabels: ['bug'],
        addAssignees: ['octo'],
        removeAssignees: ['mona']
      }
    })
    expect(store.getState().projectViewCache[cacheKey]?.data?.rows[0].content).toMatchObject({
      title: 'Updated issue',
      labels: [{ name: 'enhancement', color: '808080' }],
      assignees: [{ login: 'octo', name: null, avatarUrl: null }]
    })

    await expect(
      store
        .getState()
        .patchProjectIssueOrPr(cacheKey, 'row-pr', { title: 'Updated PR', addLabels: ['review'] })
    ).resolves.toEqual({ ok: true })
    expect(mockApi.gh.updatePullRequestBySlug).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      number: 43,
      updates: { title: 'Updated PR' }
    })
    expect(mockApi.gh.updateIssueBySlug).toHaveBeenLastCalledWith({
      owner: 'acme',
      repo: 'widgets',
      number: 43,
      updates: { title: 'Updated PR', addLabels: ['review'] }
    })
  })

  it('validates missing project rows and malformed slugs', async () => {
    const store = createTestStore()
    const { cacheKey } = seedProject(store)

    await expect(
      store.getState().updateProjectFieldValue(cacheKey, 'missing', 'field-status', {
        kind: 'text',
        text: 'no row'
      })
    ).resolves.toMatchObject({ ok: false, error: { message: 'Row not found' } })

    store.setState((state) => ({
      projectViewCache: {
        ...state.projectViewCache,
        [cacheKey]: {
          ...state.projectViewCache[cacheKey],
          data: {
            ...state.projectViewCache[cacheKey].data!,
            rows: [
              {
                ...state.projectViewCache[cacheKey].data!.rows[0],
                content: {
                  ...state.projectViewCache[cacheKey].data!.rows[0].content,
                  repository: null
                }
              }
            ]
          }
        }
      }
    }))

    await expect(
      store.getState().patchProjectIssueOrPr(cacheKey, 'row-issue', { title: 'No slug' })
    ).resolves.toMatchObject({ ok: false, error: { type: 'validation_error' } })
  })

  it('patches issue type and validates non-issue rows', async () => {
    const store = createTestStore()
    const { cacheKey } = seedProject(store)

    await expect(
      store.getState().patchProjectRowIssueType(cacheKey, 'row-issue', {
        id: 'bug',
        name: 'Bug',
        color: 'RED',
        description: 'Breakage'
      })
    ).resolves.toEqual({ ok: true })
    expect(store.getState().projectViewCache[cacheKey]?.data?.rows[0].content.issueType).toEqual({
      id: 'bug',
      name: 'Bug',
      color: 'RED',
      description: 'Breakage'
    })
    expect(mockApi.gh.updateIssueTypeBySlug).toHaveBeenCalledWith({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      issueTypeId: 'bug'
    })

    await expect(
      store.getState().patchProjectRowIssueType(cacheKey, 'row-pr', null)
    ).resolves.toMatchObject({
      ok: false,
      error: { type: 'validation_error', message: 'Issue Type can only be set on Issues.' }
    })
  })

  it('patches project row content without IPC', () => {
    const store = createTestStore()
    const { cacheKey } = seedProject(store)

    store.getState().patchProjectRowContent(cacheKey, 'row-issue', {
      title: 'Local title',
      body: 'Local body',
      state: 'closed',
      labels: ['bug', 'new'],
      assignees: ['mona', 'octo']
    })

    expect(store.getState().projectViewCache[cacheKey]?.data?.rows[0].content).toMatchObject({
      title: 'Local title',
      body: 'Local body',
      state: 'CLOSED',
      labels: [
        { name: 'bug', color: 'red' },
        { name: 'new', color: '808080' }
      ],
      assignees: [
        { login: 'mona', name: null, avatarUrl: null },
        { login: 'octo', name: null, avatarUrl: null }
      ]
    })
  })
})

describe('createGitHubSlice work item pagination and counts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('fetches next pages across repos and records failures', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems
      .mockResolvedValueOnce({
        items: [
          { id: 'a', type: 'issue', number: 1, title: 'A', updatedAt: '2026-01-02T00:00:00Z' }
        ],
        sources: { issues: null, prs: null, upstreamCandidate: null }
      })
      .mockRejectedValueOnce(new Error('repo failed'))

    const result = await store.getState().fetchWorkItemsNextPage(
      [
        { repoId: 'repo-a', path: '/repo/a' },
        { repoId: 'repo-b', path: '/repo/b' }
      ],
      10,
      10,
      'is:open',
      '2026-01-01T00:00:00Z'
    )

    expect(result).toMatchObject({
      failedCount: 1,
      items: [{ id: 'a', repoId: 'repo-a' }]
    })
    expect(mockApi.gh.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/repo/a',
      repoId: 'repo-a',
      limit: 10,
      query: 'is:open',
      before: '2026-01-01T00:00:00Z'
    })
  })

  it('counts work items across repos and treats failures as zero', async () => {
    const store = createTestStore()
    mockApi.gh.countWorkItems.mockResolvedValueOnce(3).mockRejectedValueOnce(new Error('nope'))

    await expect(
      store.getState().countWorkItemsAcrossRepos(
        [
          { repoId: 'repo-a', path: '/repo/a' },
          { repoId: 'repo-b', path: '/repo/b' }
        ],
        'assigned:@me'
      )
    ).resolves.toBe(3)
  })

  it('prefetches only when the cache is cold', async () => {
    const store = createTestStore()
    mockApi.gh.listWorkItems.mockResolvedValue({
      items: [],
      sources: { issues: null, prs: null, upstreamCandidate: null }
    })

    store.getState().prefetchWorkItems('repo-a', '/repo/a', 5, '')
    await vi.waitFor(() => expect(mockApi.gh.listWorkItems).toHaveBeenCalledTimes(1))
    mockApi.gh.listWorkItems.mockClear()
    store.getState().prefetchWorkItems('repo-a', '/repo/a', 5, '')
    expect(mockApi.gh.listWorkItems).not.toHaveBeenCalled()
  })
})

describe('IssueSourceIndicator suppression', () => {
  it('hides when sources deep-equal, shows when they differ, hides when either is null', async () => {
    const { default: IssueSourceIndicator, sameGitHubOwnerRepo } =
      await import('../../components/github/IssueSourceIndicator')
    const React = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')

    // Same slug → null (no information to convey)
    expect(sameGitHubOwnerRepo({ owner: 'o', repo: 'r' }, { owner: 'o', repo: 'r' })).toBe(true)
    // Case-insensitive equality — the parent design doc calls out that `StablyAI/Orca`
    // and `stablyai/orca` resolve to the same repo and must suppress.
    expect(
      sameGitHubOwnerRepo({ owner: 'StablyAI', repo: 'Orca' }, { owner: 'stablyai', repo: 'orca' })
    ).toBe(true)
    expect(sameGitHubOwnerRepo({ owner: 'a', repo: 'r' }, { owner: 'b', repo: 'r' })).toBe(false)

    // null on either side → element renders as null (empty render)
    const sameEl = React.createElement(IssueSourceIndicator, {
      issues: { owner: 'o', repo: 'r' },
      prs: { owner: 'o', repo: 'r' }
    })
    expect(renderToStaticMarkup(sameEl)).toBe('')

    const nullIssueEl = React.createElement(IssueSourceIndicator, {
      issues: null,
      prs: { owner: 'o', repo: 'r' }
    })
    expect(renderToStaticMarkup(nullIssueEl)).toBe('')

    const diffEl = React.createElement(IssueSourceIndicator, {
      issues: { owner: 'up', repo: 'r' },
      prs: { owner: 'fork', repo: 'r' }
    })
    const defaultMarkup = renderToStaticMarkup(diffEl)
    expect(defaultMarkup).toContain('up/r')
    // Default variant is 'list' → plural prefix on list surfaces.
    expect(defaultMarkup).toContain('Issues from')

    // 'item' variant → singular prefix on detail surfaces where the chip
    // annotates a single issue (e.g. GitHubItemDialog).
    const itemEl = React.createElement(IssueSourceIndicator, {
      issues: { owner: 'up', repo: 'r' },
      prs: { owner: 'fork', repo: 'r' },
      variant: 'item'
    })
    const itemMarkup = renderToStaticMarkup(itemEl)
    expect(itemMarkup).toContain('up/r')
    expect(itemMarkup).toContain('Issue from')
    expect(itemMarkup).not.toContain('Issues from')
  })
})
