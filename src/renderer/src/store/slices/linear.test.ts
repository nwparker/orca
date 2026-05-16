import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { LinearIssue, LinearViewer } from '../../../../shared/types'
import { createLinearSlice } from './linear'
import { clearLinearMetadataCache } from '../../hooks/useIssueMetadata'
import {
  linearConnect,
  linearDisconnect,
  linearGetIssue,
  linearListIssues,
  linearSearchIssues,
  linearStatus,
  linearTestConnection
} from '@/runtime/runtime-linear-client'

vi.mock('@/runtime/runtime-linear-client', () => ({
  linearConnect: vi.fn(),
  linearDisconnect: vi.fn(),
  linearGetIssue: vi.fn(),
  linearListIssues: vi.fn(),
  linearSearchIssues: vi.fn(),
  linearStatus: vi.fn(),
  linearTestConnection: vi.fn()
}))

vi.mock('../../hooks/useIssueMetadata', () => ({
  clearLinearMetadataCache: vi.fn()
}))

const settings = { activeRuntimeEnvironmentId: null }
const viewer: LinearViewer = {
  displayName: 'Mona',
  email: 'mona@example.com',
  organizationName: 'Acme'
}

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createLinearSlice(...a),
        settings
      }) as AppState
  )
}

function makeIssue(overrides: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'issue-1',
    identifier: 'ENG-1',
    title: 'Fix Linear cache',
    url: 'https://linear.app/acme/issue/ENG-1',
    state: { name: 'Todo', type: 'unstarted', color: '#999999' },
    team: { id: 'team-1', name: 'Engineering', key: 'ENG' },
    labels: [],
    labelIds: [],
    priority: 0,
    updatedAt: '2026-05-15T12:00:00.000Z',
    ...overrides
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-05-15T12:00:00.000Z'))
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.mocked(linearStatus).mockResolvedValue({ connected: false, viewer: null })
  vi.mocked(linearTestConnection).mockResolvedValue({ ok: true, viewer })
  vi.mocked(linearConnect).mockResolvedValue({ ok: true, viewer })
  vi.mocked(linearDisconnect).mockResolvedValue(undefined)
  vi.mocked(linearGetIssue).mockResolvedValue(makeIssue())
  vi.mocked(linearSearchIssues).mockResolvedValue([makeIssue()])
  vi.mocked(linearListIssues).mockResolvedValue([makeIssue({ id: 'issue-2', identifier: 'ENG-2' })])
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createLinearSlice connection state', () => {
  it('checks, tests, connects, and disconnects Linear connection state', async () => {
    const store = createTestStore()

    vi.mocked(linearStatus).mockResolvedValueOnce({ connected: true, viewer })
    await store.getState().checkLinearConnection()

    expect(linearStatus).toHaveBeenCalledWith(settings)
    expect(store.getState().linearStatus).toEqual({ connected: true, viewer })
    expect(store.getState().linearStatusChecked).toBe(true)

    vi.mocked(linearStatus).mockResolvedValueOnce({ connected: true, viewer })
    await store.getState().checkLinearConnection()
    expect(store.getState().linearStatus).toEqual({ connected: true, viewer })

    vi.mocked(linearTestConnection).mockResolvedValueOnce({ ok: false, error: 'Unauthorized' })
    await expect(store.getState().testLinearConnection()).resolves.toEqual({
      ok: false,
      error: 'Unauthorized'
    })
    expect(store.getState().linearStatus).toEqual({ connected: false, viewer: null })

    vi.mocked(linearConnect).mockResolvedValueOnce({ ok: true, viewer })
    vi.mocked(linearStatus).mockResolvedValue({ connected: true, viewer })
    await expect(store.getState().connectLinear('lin_api_key')).resolves.toEqual({
      ok: true,
      viewer
    })
    expect(linearConnect).toHaveBeenCalledWith(settings, 'lin_api_key')
    expect(store.getState().linearStatus).toEqual({ connected: true, viewer })

    store.setState({
      linearIssueCache: { 'issue-1': { data: makeIssue(), fetchedAt: Date.now() } },
      linearSearchCache: { search: { data: [makeIssue()], fetchedAt: Date.now() } }
    })
    await store.getState().disconnectLinear()

    expect(linearDisconnect).toHaveBeenCalledWith(settings)
    expect(clearLinearMetadataCache).toHaveBeenCalled()
    expect(store.getState().linearStatus).toEqual({ connected: false, viewer: null })
    expect(store.getState().linearIssueCache).toEqual({})
    expect(store.getState().linearSearchCache).toEqual({})
  })

  it('marks status checked when status calls fail and returns connection errors', async () => {
    const store = createTestStore()

    vi.mocked(linearStatus).mockRejectedValueOnce(new Error('offline'))
    await store.getState().checkLinearConnection()
    expect(store.getState().linearStatusChecked).toBe(true)
    expect(store.getState().linearStatus).toEqual({ connected: false, viewer: null })

    store.setState({ linearStatus: { connected: true, viewer } })
    vi.mocked(linearStatus).mockRejectedValueOnce(new Error('offline'))
    await store.getState().checkLinearConnection()
    expect(store.getState().linearStatus).toEqual({ connected: false, viewer: null })

    vi.mocked(linearTestConnection).mockRejectedValueOnce(new Error('Test exploded'))
    await expect(store.getState().testLinearConnection()).resolves.toEqual({
      ok: false,
      error: 'Test exploded'
    })

    vi.mocked(linearConnect).mockRejectedValueOnce(new Error('Connect exploded'))
    await expect(store.getState().connectLinear('bad-key')).resolves.toEqual({
      ok: false,
      error: 'Connect exploded'
    })
  })
})

describe('createLinearSlice issue caches', () => {
  it('reuses fresh issue cache entries, dedupes in-flight fetches, and prunes old entries', async () => {
    const store = createTestStore()
    const cachedIssue = makeIssue({ id: 'cached', identifier: 'ENG-10' })

    store.setState({
      linearIssueCache: {
        cached: { data: cachedIssue, fetchedAt: Date.now() }
      }
    })

    await expect(store.getState().fetchLinearIssue('cached')).resolves.toBe(cachedIssue)
    expect(linearGetIssue).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_001)
    const latestIssue = makeIssue({ id: 'cached', identifier: 'ENG-10', title: 'Refetched' })
    const inflight = deferred<LinearIssue | null>()
    vi.mocked(linearGetIssue).mockReturnValueOnce(inflight.promise)

    const first = store.getState().fetchLinearIssue('cached')
    const second = store.getState().fetchLinearIssue('cached')
    expect(linearGetIssue).toHaveBeenCalledTimes(1)

    inflight.resolve(latestIssue)
    await expect(first).resolves.toBe(latestIssue)
    await expect(second).resolves.toBe(latestIssue)
    expect(store.getState().linearIssueCache['selected::cached']?.data).toBe(latestIssue)

    const oldEntries = Object.fromEntries(
      Array.from({ length: 501 }, (_, index) => [
        `old-${index}`,
        { data: makeIssue({ id: `old-${index}`, identifier: `ENG-${index}` }), fetchedAt: index }
      ])
    )
    store.setState({ linearIssueCache: oldEntries })
    vi.mocked(linearGetIssue).mockResolvedValueOnce(makeIssue({ id: 'new', identifier: 'ENG-999' }))

    await store.getState().fetchLinearIssue('new')

    expect(Object.keys(store.getState().linearIssueCache)).toHaveLength(500)
    expect(store.getState().linearIssueCache['old-0']).toBeUndefined()
    expect(store.getState().linearIssueCache['selected::new']?.data?.identifier).toBe('ENG-999')
  })

  it('returns null and disconnects on authenticated issue fetch failures', async () => {
    const store = createTestStore()
    store.setState({ linearStatus: { connected: true, viewer } })
    vi.mocked(linearGetIssue).mockRejectedValueOnce(new Error('401 unauthorized'))

    await expect(store.getState().fetchLinearIssue('issue-1')).resolves.toBeNull()

    expect(console.warn).toHaveBeenCalled()
    expect(store.getState().linearStatus).toEqual({ connected: false, viewer: null })
  })

  it('caches search and list results, dedupes requests, and handles auth errors', async () => {
    const store = createTestStore()
    const searchIssue = makeIssue({ id: 'search-1', identifier: 'ENG-20' })
    const search = deferred<LinearIssue[]>()
    vi.mocked(linearSearchIssues).mockReturnValueOnce(search.promise)

    const firstSearch = store.getState().searchLinearIssues('cache', 5)
    const secondSearch = store.getState().searchLinearIssues('cache', 5)
    expect(linearSearchIssues).toHaveBeenCalledTimes(1)
    expect(linearSearchIssues).toHaveBeenCalledWith(settings, 'cache', 5, null)

    search.resolve([searchIssue])
    await expect(firstSearch).resolves.toEqual([searchIssue])
    await expect(secondSearch).resolves.toEqual([searchIssue])

    await expect(store.getState().searchLinearIssues('cache', 5)).resolves.toEqual([searchIssue])
    expect(linearSearchIssues).toHaveBeenCalledTimes(1)

    const listIssue = makeIssue({ id: 'list-1', identifier: 'ENG-21' })
    const list = deferred<LinearIssue[]>()
    vi.mocked(linearListIssues).mockReturnValueOnce(list.promise)

    const firstList = store.getState().listLinearIssues('created', 10)
    const secondList = store.getState().listLinearIssues('created', 10)
    expect(linearListIssues).toHaveBeenCalledTimes(1)
    expect(linearListIssues).toHaveBeenCalledWith(settings, 'created', 10, null)

    list.resolve([listIssue])
    await expect(firstList).resolves.toEqual([listIssue])
    await expect(secondList).resolves.toEqual([listIssue])
    await expect(store.getState().listLinearIssues('created', 10)).resolves.toEqual([listIssue])
    expect(linearListIssues).toHaveBeenCalledTimes(1)

    store.setState({ linearStatus: { connected: true, viewer } })
    vi.mocked(linearSearchIssues).mockRejectedValueOnce(new Error('authentication required'))
    await expect(store.getState().searchLinearIssues('expired', 20)).resolves.toEqual([])
    expect(store.getState().linearStatus).toEqual({ connected: false, viewer: null })

    store.setState({ linearStatus: { connected: true, viewer } })
    vi.mocked(linearListIssues).mockRejectedValueOnce(new Error('Unauthorized'))
    await expect(store.getState().listLinearIssues('completed', 20)).resolves.toEqual([])
    expect(store.getState().linearStatus).toEqual({ connected: false, viewer: null })
  })

  it('patches matching issue and search cache entries without changing unrelated entries', () => {
    const store = createTestStore()
    const issue = makeIssue({ id: 'issue-1', title: 'Before' })
    const otherIssue = makeIssue({ id: 'issue-2', identifier: 'ENG-2', title: 'Other' })

    store.setState({
      linearIssueCache: {
        'issue-1': { data: issue, fetchedAt: Date.now() }
      },
      linearSearchCache: {
        matches: { data: [issue, otherIssue], fetchedAt: Date.now() },
        untouched: { data: [otherIssue], fetchedAt: Date.now() }
      }
    })

    store.getState().patchLinearIssue('issue-1', { title: 'After', priority: 2 })

    expect(store.getState().linearIssueCache['issue-1']?.data?.title).toBe('After')
    expect(store.getState().linearIssueCache['issue-1']?.fetchedAt).toBe(0)
    expect(store.getState().linearSearchCache.matches?.data?.[0]?.title).toBe('After')
    expect(store.getState().linearSearchCache.matches?.data?.[0]?.priority).toBe(2)
    expect(store.getState().linearSearchCache.untouched?.data?.[0]).toBe(otherIssue)

    const issueCacheBeforeNoop = store.getState().linearIssueCache
    const searchCacheBeforeNoop = store.getState().linearSearchCache
    store.getState().patchLinearIssue('missing', { title: 'Noop' })
    expect(store.getState().linearIssueCache).toBe(issueCacheBeforeNoop)
    expect(store.getState().linearSearchCache).toBe(searchCacheBeforeNoop)
  })
})
