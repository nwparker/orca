import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRateLimitSlice } from './rate-limits'
import { createEmptyRateLimitState } from '../../../../shared/rate-limit-state-factory'
import type { RateLimitState } from '../../../../shared/rate-limit-types'
import type { AppState } from '../types'

function createRateLimitStore(): StoreApi<AppState> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) =>
    createRateLimitSlice(...(args as Parameters<typeof createRateLimitSlice>))
  ) as unknown as StoreApi<AppState>
}

describe('createRateLimitSlice', () => {
  it('initializes Antigravity usage with a stable pending key', () => {
    const store = createRateLimitStore()

    expect(store.getState().rateLimits.antigravity).toBeNull()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('keeps a pushed snapshot when an older Devin refresh response arrives later', async () => {
    let finish: ((state: RateLimitState) => void) | undefined
    vi.stubGlobal('window', {
      api: {
        rateLimits: {
          refreshDevin: () =>
            new Promise<RateLimitState>((resolve) => {
              finish = resolve
            })
        }
      }
    })
    const store = createRateLimitStore()
    const refreshing = store.getState().refreshDevinRateLimits()
    const pushed = createEmptyRateLimitState()
    store.getState().setRateLimitsFromPush(pushed)
    finish?.(createEmptyRateLimitState())
    await refreshing
    expect(store.getState().rateLimits).toBe(pushed)
  })
})
