/* eslint-disable max-lines -- Why: these tests mirror the fetch ordering,
stale-data handling, account-switch generation, and OpenCode config-change
semantics covered in service.ts, which already carries the same pragma.
Keeping them in one file makes the ordering contract reviewable as a unit. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchClaudeRateLimits, fetchManagedAccountUsage } from './claude-fetcher'
import { fetchCodexRateLimits } from './codex-fetcher'
import { fetchGeminiRateLimits } from './gemini-usage-fetcher'
import { fetchOpenCodeGoRateLimits } from './opencode-go-usage-fetcher'

vi.mock('./claude-fetcher', () => ({
  fetchClaudeRateLimits: vi.fn(),
  fetchManagedAccountUsage: vi.fn()
}))

vi.mock('./codex-fetcher', () => ({
  fetchCodexRateLimits: vi.fn()
}))

vi.mock('./gemini-usage-fetcher', () => ({
  fetchGeminiRateLimits: vi.fn()
}))

vi.mock('./opencode-go-usage-fetcher', () => ({
  fetchOpenCodeGoRateLimits: vi.fn()
}))

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

function okProvider(
  provider: 'claude' | 'codex' | 'gemini' | 'opencode-go',
  usedPercent: number,
  updatedAt = Date.now()
): ProviderRateLimits {
  return {
    provider,
    session: {
      usedPercent,
      windowMinutes: 300,
      resetsAt: null,
      resetDescription: null
    },
    weekly: null,
    updatedAt,
    error: null,
    status: 'ok'
  }
}

function errorProvider(
  provider: 'claude' | 'codex' | 'gemini' | 'opencode-go',
  message: string
): ProviderRateLimits {
  return {
    provider,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: message,
    status: 'error'
  }
}

function serviceInternals(service: RateLimitService): { fetchAll: () => Promise<void> } {
  return service as unknown as { fetchAll: () => Promise<void> }
}

describe('RateLimitService', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 0, Date.now()))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(okProvider('opencode-go', 0, Date.now()))
  })

  it('does not refetch Claude when a Codex account switch is queued during fetchAll', async () => {
    const service = new RateLimitService()
    const firstClaude = deferred<ProviderRateLimits>()
    const firstCodex = deferred<ProviderRateLimits>()

    vi.mocked(fetchClaudeRateLimits).mockImplementationOnce(() => firstClaude.promise)
    vi.mocked(fetchCodexRateLimits)
      .mockImplementationOnce(() => firstCodex.promise)
      .mockResolvedValueOnce(okProvider('codex', 42))

    const fullRefresh = service.refresh()
    await Promise.resolve()

    const switchRefresh = service.refreshForCodexAccountChange()
    await Promise.resolve()

    firstClaude.resolve(okProvider('claude', 18))
    firstCodex.resolve(okProvider('codex', 24))

    await fullRefresh
    await switchRefresh

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('keeps recent stale data across repeated failures', async () => {
    const service = new RateLimitService()
    const internal = serviceInternals(service)

    vi.mocked(fetchClaudeRateLimits)
      .mockResolvedValueOnce(okProvider('claude', 33, Date.now()))
      .mockResolvedValueOnce(errorProvider('claude', 'temporary failure'))
      .mockResolvedValueOnce(errorProvider('claude', 'still failing'))

    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(okProvider('codex', 44, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 44, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 44, Date.now()))

    await internal.fetchAll()
    await internal.fetchAll()

    let state = service.getState()
    expect(state.claude?.status).toBe('error')
    expect(state.claude?.session?.usedPercent).toBe(33)

    await internal.fetchAll()

    state = service.getState()
    expect(state.claude?.status).toBe('error')
    expect(state.claude?.session?.usedPercent).toBe(33)
    expect(state.claude?.error).toBe('still failing')
  })

  it('bypasses the debounce for explicit manual refreshes', async () => {
    const service = new RateLimitService()

    vi.mocked(fetchClaudeRateLimits)
      .mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
      .mockResolvedValueOnce(okProvider('claude', 11, Date.now()))

    vi.mocked(fetchCodexRateLimits)
      .mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
      .mockResolvedValueOnce(okProvider('codex', 21, Date.now()))

    await service.refresh()
    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('waits for a queued explicit refresh when another fetch is already in flight', async () => {
    const service = new RateLimitService()
    const firstClaude = deferred<ProviderRateLimits>()
    const firstCodex = deferred<ProviderRateLimits>()
    const secondClaude = deferred<ProviderRateLimits>()
    const secondCodex = deferred<ProviderRateLimits>()

    vi.mocked(fetchClaudeRateLimits)
      .mockImplementationOnce(() => firstClaude.promise)
      .mockImplementationOnce(() => secondClaude.promise)
    vi.mocked(fetchCodexRateLimits)
      .mockImplementationOnce(() => firstCodex.promise)
      .mockImplementationOnce(() => secondCodex.promise)

    const backgroundFetch = serviceInternals(service).fetchAll()
    await Promise.resolve()

    let refreshResolved = false
    const manualRefresh = service.refresh().then(() => {
      refreshResolved = true
    })
    await Promise.resolve()

    firstClaude.resolve(okProvider('claude', 10, Date.now()))
    firstCodex.resolve(okProvider('codex', 20, Date.now()))
    await Promise.resolve()

    expect(refreshResolved).toBe(false)

    secondClaude.resolve(okProvider('claude', 11, Date.now()))
    secondCodex.resolve(okProvider('codex', 21, Date.now()))
    await backgroundFetch
    await manualRefresh

    expect(refreshResolved).toBe(true)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(2)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(2)
  })

  it('fetches Gemini and OpenCode Go alongside Claude and Codex', async () => {
    const service = new RateLimitService()
    service.setSettingsResolver(() => ({
      opencodeSessionCookie: 'session=abc123',
      opencodeWorkspaceId: ''
    }))

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(okProvider('gemini', 30, Date.now()))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValueOnce(
      okProvider('opencode-go', 40, Date.now())
    )

    await service.refresh()

    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchGeminiRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchOpenCodeGoRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchOpenCodeGoRateLimits).toHaveBeenCalledWith('session=abc123', undefined)

    const state = service.getState()
    expect(state.claude?.status).toBe('ok')
    expect(state.claude?.session?.usedPercent).toBe(10)
    expect(state.codex?.status).toBe('ok')
    expect(state.codex?.session?.usedPercent).toBe(20)
    expect(state.gemini?.status).toBe('ok')
    expect(state.gemini?.session?.usedPercent).toBe(30)
    expect(state.opencodeGo?.status).toBe('ok')
    expect(state.opencodeGo?.session?.usedPercent).toBe(40)
  })

  it('preserves Gemini buckets through getState after fetch', async () => {
    const service = new RateLimitService()

    const geminiWithBuckets: ProviderRateLimits = {
      provider: 'gemini',
      session: { usedPercent: 80, windowMinutes: 300, resetsAt: null, resetDescription: null },
      weekly: null,
      buckets: [
        {
          name: 'Pro',
          usedPercent: 30,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        },
        {
          name: 'Flash',
          usedPercent: 80,
          windowMinutes: 300,
          resetsAt: null,
          resetDescription: null
        }
      ],
      updatedAt: Date.now(),
      error: null,
      status: 'ok'
    }

    vi.mocked(fetchClaudeRateLimits).mockResolvedValueOnce(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValueOnce(geminiWithBuckets)
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValueOnce(
      okProvider('opencode-go', 0, Date.now())
    )

    await service.refresh()

    const state = service.getState()
    expect(state.gemini?.buckets).toHaveLength(2)
    expect(state.gemini?.buckets![0].name).toBe('Pro')
    expect(state.gemini?.buckets![1].name).toBe('Flash')
    // Why: session summary is derived from bucket data and must match the most constrained bucket.
    expect(state.gemini?.session?.usedPercent).toBe(80)
  })

  it('isolates provider failures so one error does not block others', async () => {
    const service = new RateLimitService()
    service.setSettingsResolver(() => ({ opencodeSessionCookie: '', opencodeWorkspaceId: '' }))

    vi.mocked(fetchClaudeRateLimits).mockRejectedValueOnce(new Error('claude down'))
    vi.mocked(fetchCodexRateLimits).mockResolvedValueOnce(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockRejectedValueOnce(new Error('gemini down'))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValueOnce(
      okProvider('opencode-go', 40, Date.now())
    )

    await service.refresh()

    const state = service.getState()
    expect(state.claude?.status).toBe('error')
    expect(state.claude?.error).toBe('claude down')
    expect(state.codex?.status).toBe('ok')
    expect(state.gemini?.status).toBe('error')
    expect(state.gemini?.error).toBe('gemini down')
    expect(state.opencodeGo?.status).toBe('ok')
  })

  it('discards stale data when a provider becomes unavailable', async () => {
    const service = new RateLimitService()
    let cookie = 'session=valid'
    service.setSettingsResolver(() => ({ opencodeSessionCookie: cookie, opencodeWorkspaceId: '' }))

    // 1. Success fetch
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 10, Date.now()))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20, Date.now()))
    vi.mocked(fetchGeminiRateLimits).mockResolvedValue(okProvider('gemini', 30, Date.now()))
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(
      okProvider('opencode-go', 40, Date.now())
    )

    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(40)

    // 2. Clear cookie -> should become unavailable and LOSE the 40% data
    cookie = ''
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue({
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: 'Session cookie not configured',
      status: 'unavailable'
    })

    await service.refresh()
    const state = service.getState()
    expect(state.opencodeGo?.status).toBe('unavailable')
    expect(state.opencodeGo?.session).toBeNull()
    expect(state.opencodeGo?.error).toBe('Session cookie not configured')
  })

  it('discards stale data when Workspace ID override is changed', async () => {
    const service = new RateLimitService()
    let workspaceId = 'wrk_A'
    service.setSettingsResolver(() => ({
      opencodeSessionCookie: 'session=valid',
      opencodeWorkspaceId: workspaceId
    }))

    // 1. Success fetch for Workspace A
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(
      okProvider('opencode-go', 40, Date.now())
    )
    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(40)

    // 2. Change Workspace ID to B -> old data from A should be discarded
    workspaceId = 'wrk_B'
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue(
      okProvider('opencode-go', 10, Date.now())
    )
    await service.refresh()
    expect(service.getState().opencodeGo?.session?.usedPercent).toBe(10)

    // 3. Clear Workspace ID (automatic) but it fails -> should show error, NOT stale data from B
    workspaceId = ''
    vi.mocked(fetchOpenCodeGoRateLimits).mockResolvedValue({
      provider: 'opencode-go',
      session: null,
      weekly: null,
      monthly: null,
      updatedAt: Date.now(),
      error: 'No workspace ID found',
      status: 'error'
    })
    await service.refresh()
    const state = service.getState()
    expect(state.opencodeGo?.status).toBe('error')
    expect(state.opencodeGo?.session).toBeNull()
    expect(state.opencodeGo?.error).toBe('No workspace ID found')
  })

  it('does not recache an inactive Claude account removed during fetch-on-open', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    let inactiveAccounts = [{ id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }]
    service.setInactiveClaudeAccountsResolver(() => inactiveAccounts)
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '/tmp/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }))
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    await service.refresh()
    vi.mocked(fetchManagedAccountUsage).mockReturnValueOnce(accountFetch.promise)

    const fetchOnOpen = service.fetchInactiveClaudeAccountsOnOpen()
    await Promise.resolve()
    expect(service.getState().inactiveClaudeAccounts).toEqual([
      { accountId: 'account-1', claude: null, updatedAt: 0, isFetching: true }
    ])

    service.evictInactiveClaudeCache('account-1')
    inactiveAccounts = [{ id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }]
    await service.refreshForClaudeAccountChange('account-1')
    expect(service.getState().inactiveClaudeAccounts[0]?.accountId).toBe('account-1')

    inactiveAccounts = []
    service.evictInactiveClaudeCache('account-1')
    accountFetch.resolve(okProvider('claude', 42))
    await fetchOnOpen

    expect(service.getState().inactiveClaudeAccounts).toEqual([])
  })

  it('does not overwrite inactive Claude cache from a stale same-id fetch', async () => {
    const service = new RateLimitService()
    const accountFetch = deferred<ProviderRateLimits>()
    service.setInactiveClaudeAccountsResolver(() => [
      { id: 'account-1', managedAuthPath: '/tmp/account-1/auth' }
    ])
    service.setClaudeAuthPreparationResolver(async () => ({
      configDir: '/tmp/.claude',
      envPatch: {},
      stripAuthEnv: false,
      provenance: 'system'
    }))
    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 7))
    await service.refresh()
    vi.mocked(fetchManagedAccountUsage).mockReturnValueOnce(accountFetch.promise)

    const fetchOnOpen = service.fetchInactiveClaudeAccountsOnOpen()
    await Promise.resolve()

    await service.refreshForClaudeAccountChange('account-1')
    accountFetch.resolve(okProvider('claude', 42))
    await fetchOnOpen

    expect(service.getState().inactiveClaudeAccounts).toEqual([
      {
        accountId: 'account-1',
        claude: expect.objectContaining({
          session: expect.objectContaining({ usedPercent: 7 })
        }),
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])
  })

  it('pushes state to listeners and the attached renderer while polling only active windows', async () => {
    vi.useFakeTimers()
    const service = new RateLimitService()
    const listener = vi.fn()
    const unsubscribe = service.onStateChange(listener)
    const send = vi.fn()
    const handlers = new Map<string, () => void>()
    const mainWindow = {
      webContents: { send },
      isDestroyed: vi.fn(() => false),
      isVisible: vi.fn(() => true),
      isMinimized: vi.fn(() => false),
      isFocused: vi.fn(() => true),
      on: vi.fn((event: string, handler: () => void) => {
        handlers.set(event, handler)
      }),
      removeListener: vi.fn((event: string, handler: () => void) => {
        if (handlers.get(event) === handler) {
          handlers.delete(event)
        }
      })
    }

    vi.mocked(fetchClaudeRateLimits).mockResolvedValue(okProvider('claude', 10))
    vi.mocked(fetchCodexRateLimits).mockResolvedValue(okProvider('codex', 20))
    service.attach(mainWindow as never)
    service.setPollingInterval(30_000)
    service.start()
    await vi.runOnlyPendingTimersAsync()
    await Promise.resolve()

    expect(listener).toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(
      'rateLimits:update',
      expect.objectContaining({
        claude: expect.objectContaining({ provider: 'claude' }),
        codex: expect.objectContaining({ provider: 'codex' })
      })
    )

    vi.mocked(fetchClaudeRateLimits).mockClear()
    vi.mocked(fetchCodexRateLimits).mockClear()
    mainWindow.isFocused.mockReturnValue(false)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(fetchClaudeRateLimits).not.toHaveBeenCalled()
    expect(fetchCodexRateLimits).not.toHaveBeenCalled()

    mainWindow.isFocused.mockReturnValue(true)
    handlers.get('focus')?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)

    unsubscribe()
    handlers.get('closed')?.()
    expect(mainWindow.removeListener).toHaveBeenCalled()
    service.stop()
  })

  it('fetches, debounces, and evicts inactive Codex account usage', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-15T12:00:00Z'))
    const service = new RateLimitService()
    service.setInactiveCodexAccountsResolver(() => [
      { id: 'codex-1', managedHomePath: '/tmp/codex-1' },
      { id: 'codex-2', managedHomePath: '/tmp/codex-2' }
    ])
    const firstAccount = deferred<ProviderRateLimits>()
    const secondAccount = deferred<ProviderRateLimits>()
    vi.mocked(fetchCodexRateLimits)
      .mockImplementationOnce(() => firstAccount.promise)
      .mockImplementationOnce(() => secondAccount.promise)

    const fetchOnOpen = service.fetchInactiveCodexAccountsOnOpen()
    await Promise.resolve()
    expect(service.getState().inactiveCodexAccounts).toEqual([
      { accountId: 'codex-1', claude: null, updatedAt: 0, isFetching: true },
      { accountId: 'codex-2', claude: null, updatedAt: 0, isFetching: true }
    ])

    firstAccount.resolve(okProvider('codex', 11))
    secondAccount.reject(new Error('missing token'))
    await fetchOnOpen
    expect(fetchCodexRateLimits).toHaveBeenCalledWith({ codexHomePath: '/tmp/codex-1' })
    expect(fetchCodexRateLimits).toHaveBeenCalledWith({ codexHomePath: '/tmp/codex-2' })
    expect(service.getState().inactiveCodexAccounts).toEqual([
      {
        accountId: 'codex-1',
        claude: expect.objectContaining({ session: expect.objectContaining({ usedPercent: 11 }) }),
        updatedAt: expect.any(Number),
        isFetching: false
      }
    ])

    vi.mocked(fetchCodexRateLimits).mockClear()
    await service.fetchInactiveCodexAccountsOnOpen()
    expect(fetchCodexRateLimits).not.toHaveBeenCalled()

    service.evictInactiveCodexCache('codex-1')
    expect(service.getState().inactiveCodexAccounts).toEqual([])
  })

  it('queues opposite account-specific refreshes behind an in-flight account switch', async () => {
    const service = new RateLimitService()
    const firstCodex = deferred<ProviderRateLimits>()
    const queuedClaude = deferred<ProviderRateLimits>()

    vi.mocked(fetchCodexRateLimits).mockImplementationOnce(() => firstCodex.promise)
    vi.mocked(fetchClaudeRateLimits).mockImplementationOnce(() => queuedClaude.promise)

    const codexSwitch = service.refreshForCodexAccountChange()
    await Promise.resolve()
    const claudeSwitch = service.refreshForClaudeAccountChange()
    await Promise.resolve()

    firstCodex.resolve(okProvider('codex', 55))
    await Promise.resolve()
    queuedClaude.resolve(okProvider('claude', 66))

    await codexSwitch
    await claudeSwitch

    expect(service.getState().codex?.session?.usedPercent).toBe(55)
    expect(service.getState().claude?.session?.usedPercent).toBe(66)
    expect(fetchCodexRateLimits).toHaveBeenCalledTimes(1)
    expect(fetchClaudeRateLimits).toHaveBeenCalledTimes(1)
  })
})
