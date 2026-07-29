import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../../shared/skills'
import {
  discoverInstalledAgentSkills,
  getSkillDiscoveryTargetKey,
  invalidateInstalledAgentSkillDiscovery,
  resetInstalledAgentSkillDiscoveryForTests
} from './installed-agent-skill-discovery'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function result(scannedAt: number): SkillDiscoveryResult {
  return { skills: [], sources: [], scannedAt }
}

afterEach(() => {
  resetInstalledAgentSkillDiscoveryForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('installed agent skill discovery lifecycle', () => {
  it('does not let a pre-install scan repopulate invalidated cache state', async () => {
    const staleScan = deferred<SkillDiscoveryResult>()
    const freshScan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<() => Promise<SkillDiscoveryResult>>()
      .mockReturnValueOnce(staleScan.promise)
      .mockReturnValueOnce(freshScan.promise)
    vi.stubGlobal('window', { api: { skills: { discover } } })
    const target = { executionHostId: 'ssh:build-host' }

    const staleRequest = discoverInstalledAgentSkills(false, target)
    invalidateInstalledAgentSkillDiscovery()
    const freshRequest = discoverInstalledAgentSkills(false, target)
    expect(discover).toHaveBeenCalledTimes(2)

    // Why: the stale scan must settle LAST — that is the only ordering where a
    // missing generation guard would overwrite the post-install result.
    freshScan.resolve(result(2))
    await expect(freshRequest).resolves.toEqual(result(2))
    staleScan.resolve(result(1))
    await expect(staleRequest).resolves.toEqual(result(1))

    await expect(discoverInstalledAgentSkills(false, target)).resolves.toEqual(result(2))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('lets a superseded scan settle without evicting the newer pending scan', async () => {
    // Why: invalidation clears the pending map mid-flight, so the pre-install
    // scan must not tear down the post-install scan's dedup entry when it lands.
    const staleScan = deferred<SkillDiscoveryResult>()
    const freshScan = deferred<SkillDiscoveryResult>()
    const lateScan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<() => Promise<SkillDiscoveryResult>>()
      .mockReturnValueOnce(staleScan.promise)
      .mockReturnValueOnce(freshScan.promise)
      .mockReturnValueOnce(lateScan.promise)
    vi.stubGlobal('window', { api: { skills: { discover } } })

    const staleRequest = discoverInstalledAgentSkills(false, undefined)
    invalidateInstalledAgentSkillDiscovery()
    const freshRequest = discoverInstalledAgentSkills(false, undefined)

    staleScan.resolve(result(1))
    await expect(staleRequest).resolves.toEqual(result(1))

    // The post-install scan is still in flight, so this must dedupe onto it
    // rather than start a third scan.
    const joinedRequest = discoverInstalledAgentSkills(false, undefined)
    expect(discover).toHaveBeenCalledTimes(2)

    freshScan.resolve(result(2))
    await expect(freshRequest).resolves.toEqual(result(2))
    await expect(joinedRequest).resolves.toEqual(result(2))
  })

  it('does not share results across remote runtime hosts', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(2))
    vi.stubGlobal('window', { api: { skills: { discover } } })

    await expect(
      discoverInstalledAgentSkills(false, { executionHostId: 'ssh:one' })
    ).resolves.toEqual(result(1))
    await expect(
      discoverInstalledAgentSkills(false, { executionHostId: 'ssh:two' })
    ).resolves.toEqual(result(2))
    await expect(
      discoverInstalledAgentSkills(false, { executionHostId: 'ssh:one' })
    ).resolves.toEqual(result(1))
    expect(discover).toHaveBeenCalledTimes(2)
    // Why: the host id partitions the renderer cache only — the main process
    // resolves the runtime itself and must not receive it.
    expect(discover).toHaveBeenNthCalledWith(1, undefined)
    expect(discover).toHaveBeenNthCalledWith(2, undefined)
  })

  it('keeps the host id out of a WSL target sent to discovery', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(result(1))
    vi.stubGlobal('window', { api: { skills: { discover } } })

    await discoverInstalledAgentSkills(false, {
      executionHostId: 'ssh:one',
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })

    expect(discover).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('includes runtime host identity in generic and project cache keys', () => {
    const projectRuntime = {
      status: 'resolved' as const,
      runtime: {
        kind: 'windows-host' as const,
        hostPlatform: 'win32' as const,
        projectId: 'repo-1',
        reason: 'project-override' as const,
        cacheKey: 'repo-1:windows-host'
      }
    }

    expect(getSkillDiscoveryTargetKey(undefined)).toBe('::host')
    expect(getSkillDiscoveryTargetKey({ executionHostId: 'ssh:one' })).toBe('ssh%3Aone::host')
    expect(getSkillDiscoveryTargetKey({ executionHostId: 'ssh:two', projectRuntime })).toBe(
      'ssh%3Atwo::repo-1:windows-host'
    )
  })
})
