import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderRateLimits } from '../../shared/rate-limit-types'
import { RateLimitService } from './service'
import { fetchDevinRateLimits } from './devin-fetcher'
import { readDevinCredentials } from './devin-credentials'
import { deferred } from './rate-limit-service-test-harness'

vi.mock('./devin-fetcher', () => ({ fetchDevinRateLimits: vi.fn() }))
vi.mock('./devin-credentials', () => ({
  readDevinCredentials: vi.fn(() => ({ status: 'missing' }))
}))

const quota = (usedPercent: number): ProviderRateLimits => ({
  provider: 'devin',
  session: { usedPercent, windowMinutes: 1440, resetsAt: null, resetDescription: null },
  weekly: null,
  updatedAt: Date.now(),
  error: null,
  status: 'ok'
})

describe('Devin credential identity fencing', () => {
  beforeEach(() => vi.clearAllMocks())

  it('drops an in-flight Devin-only result when credentials rotate', async () => {
    const oldCredentials = {
      status: 'ok' as const,
      credentials: { sessionToken: 'old', apiServerUrl: 'https://server.codeium.com' }
    }
    const newCredentials = {
      status: 'ok' as const,
      credentials: { sessionToken: 'new', apiServerUrl: 'https://server.codeium.com' }
    }
    let current = oldCredentials
    const pending = deferred<ProviderRateLimits>()
    vi.mocked(fetchDevinRateLimits).mockImplementationOnce(async () => {
      current = newCredentials
      return pending.promise
    })
    vi.mocked(readDevinCredentials).mockImplementation(() => current)
    const service = new RateLimitService()
    const refresh = service.refreshDevin()
    pending.resolve(quota(12))
    await refresh
    await pending.promise
    expect(service.getState().devin).toBeNull()
    expect(service.getState().devinAuthConfigured).toBe(true)
  })
  it('does not carry the old account quota into a failed refresh for a new account', async () => {
    vi.mocked(readDevinCredentials).mockReturnValue({
      status: 'ok',
      credentials: {
        sessionToken: 'first',
        apiServerUrl: 'https://server.codeium.com'
      }
    })
    vi.mocked(fetchDevinRateLimits).mockResolvedValueOnce(quota(12))
    const service = new RateLimitService()
    await service.refreshDevin()
    vi.mocked(readDevinCredentials).mockReturnValue({
      status: 'ok',
      credentials: {
        sessionToken: 'second',
        apiServerUrl: 'https://server.codeium.com'
      }
    })
    vi.mocked(fetchDevinRateLimits).mockResolvedValueOnce({
      ...quota(12),
      status: 'error',
      session: null,
      error: 'Offline'
    })
    await service.refreshDevin()
    expect(service.getState().devin?.session).toBeNull()
  })
})
