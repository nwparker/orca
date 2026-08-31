import { describe, expect, it, vi } from 'vitest'
import { GitCapabilityCache } from './git-capability-cache'
import {
  parseGitForWindowsVersion,
  resolveWindowsFscacheParallelCheckout,
  supportsWindowsFscacheParallelCheckout,
  WINDOWS_FSCACHE_PARALLEL_CHECKOUT_CAPABILITY
} from './windows-parallel-checkout-capability'

describe('parseGitForWindowsVersion', () => {
  it('parses the Git for Windows version shape', () => {
    expect(parseGitForWindowsVersion('git version 2.55.0.windows.3\r\n')).toEqual({
      major: 2,
      minor: 55,
      patch: 0,
      build: 3
    })
  })

  it('accepts future major versions and optional patch/build components', () => {
    expect(parseGitForWindowsVersion('git version 3.0.windows')).toEqual({
      major: 3,
      minor: 0,
      patch: 0,
      build: null
    })
  })

  it.each([
    'git version 2.54.0.windows.1',
    'git version 2.55.0',
    'git version 2.55.0 (Apple Git-155)',
    'noise\ngit version 2.55.0.windows.1',
    'git version 999999999999999999999.windows.1'
  ])('rejects or marks unsafe non-native output: %s', (output) => {
    expect(supportsWindowsFscacheParallelCheckout(output)).toBe(false)
  })
})

describe('resolveWindowsFscacheParallelCheckout', () => {
  it('probes once and reuses a supported value', async () => {
    const cache = new GitCapabilityCache()
    const probe = vi.fn(async () => 'git version 2.55.0.windows.3\n')

    await expect(resolveWindowsFscacheParallelCheckout(cache, probe)).resolves.toBe(true)
    await expect(resolveWindowsFscacheParallelCheckout(cache, probe)).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(cache.isKnownSupported(WINDOWS_FSCACHE_PARALLEL_CHECKOUT_CAPABILITY)).toBe(true)
  })

  it('coalesces concurrent probes and fails closed for unknown output', async () => {
    const cache = new GitCapabilityCache()
    let release!: (output: string) => void
    const pending = new Promise<string>((resolve) => {
      release = resolve
    })
    const probe = vi.fn(() => pending)

    const first = resolveWindowsFscacheParallelCheckout(cache, probe)
    const second = resolveWindowsFscacheParallelCheckout(cache, probe)
    expect(probe).toHaveBeenCalledTimes(1)
    release('git version 2.54.0.windows.1\n')
    await expect(Promise.all([first, second])).resolves.toEqual([false, false])
    expect(cache.isKnownSupported(WINDOWS_FSCACHE_PARALLEL_CHECKOUT_CAPABILITY)).toBe(false)
  })

  it('retries a failed probe only after the capability interval', async () => {
    const cache = new GitCapabilityCache()
    const probe = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('git version 2.55.0.windows.3')

    await expect(resolveWindowsFscacheParallelCheckout(cache, probe)).resolves.toBe(false)
    await expect(resolveWindowsFscacheParallelCheckout(cache, probe)).resolves.toBe(false)
    expect(probe).toHaveBeenCalledTimes(1)

    cache.rememberUnsupported(
      WINDOWS_FSCACHE_PARALLEL_CHECKOUT_CAPABILITY,
      Date.now() - 30 * 60_000 - 1
    )
    await expect(resolveWindowsFscacheParallelCheckout(cache, probe)).resolves.toBe(true)
    expect(probe).toHaveBeenCalledTimes(2)
  })
})
