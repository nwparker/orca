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

const resolvedWslProjectRuntime = {
  status: 'resolved' as const,
  runtime: {
    kind: 'wsl' as const,
    hostPlatform: 'wsl' as const,
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override' as const,
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
}

const resolvedHostProjectRuntime = {
  status: 'resolved' as const,
  runtime: {
    kind: 'windows-host' as const,
    hostPlatform: 'win32' as const,
    projectId: 'repo-1',
    reason: 'project-override' as const,
    cacheKey: 'repo-1:windows-host'
  }
}

const repairProjectRuntime = {
  status: 'repair-required' as const,
  repair: {
    projectId: 'repo-1',
    preferredRuntime: { kind: 'wsl' as const, distro: null },
    reason: 'wsl-distro-required' as const,
    source: 'project-override' as const,
    cacheKey: 'repo-1:repair:wsl-distro-required:default'
  }
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
    const target = { runtime: 'wsl' as const, wslDistro: 'Ubuntu' }

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

  it('serves a warm cache unforced and rescans when forced', async () => {
    // Why: the focus listener and every "re-check" action force a refresh so a
    // skill installed outside Orca is detected; a warm cache must not short it.
    const discover = vi
      .fn<() => Promise<SkillDiscoveryResult>>()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(2))
    vi.stubGlobal('window', { api: { skills: { discover } } })

    await expect(discoverInstalledAgentSkills(false, undefined)).resolves.toEqual(result(1))
    await expect(discoverInstalledAgentSkills(false, undefined)).resolves.toEqual(result(1))
    expect(discover).toHaveBeenCalledTimes(1)

    await expect(discoverInstalledAgentSkills(true, undefined)).resolves.toEqual(result(2))
    expect(discover).toHaveBeenCalledTimes(2)
    await expect(discoverInstalledAgentSkills(false, undefined)).resolves.toEqual(result(2))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('releases the pending slot so later forced refreshes rescan', async () => {
    // Why: without the settle-time cleanup the pending map grows forever and
    // every later forced refresh resolves the first, already-settled scan.
    const discover = vi
      .fn<() => Promise<SkillDiscoveryResult>>()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(2))
      .mockResolvedValueOnce(result(3))
    vi.stubGlobal('window', { api: { skills: { discover } } })

    await expect(discoverInstalledAgentSkills(true, undefined)).resolves.toEqual(result(1))
    await expect(discoverInstalledAgentSkills(true, undefined)).resolves.toEqual(result(2))
    await expect(discoverInstalledAgentSkills(true, undefined)).resolves.toEqual(result(3))
    expect(discover).toHaveBeenCalledTimes(3)
  })

  it('collapses concurrent forced refreshes onto one scan', async () => {
    // Why: an install notification fans out to every mounted skill surface at
    // once; each forces a refresh and they must not serialize into N scans.
    const scan = deferred<SkillDiscoveryResult>()
    const discover = vi.fn<() => Promise<SkillDiscoveryResult>>().mockReturnValue(scan.promise)
    vi.stubGlobal('window', { api: { skills: { discover } } })

    const requests = [
      discoverInstalledAgentSkills(true, undefined),
      discoverInstalledAgentSkills(true, undefined),
      discoverInstalledAgentSkills(true, undefined)
    ]
    scan.resolve(result(1))

    await expect(Promise.all(requests)).resolves.toEqual([result(1), result(1), result(1)])
    expect(discover).toHaveBeenCalledTimes(1)
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

  it('normalizes every target shape before it reaches discovery', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(result(1))
    vi.stubGlobal('window', { api: { skills: { discover } } })

    await discoverInstalledAgentSkills(false, { runtime: 'wsl', wslDistro: 'Ubuntu' })
    expect(discover).toHaveBeenLastCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    await discoverInstalledAgentSkills(false, { projectRuntime: resolvedWslProjectRuntime })
    expect(discover).toHaveBeenLastCalledWith({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      projectRuntime: resolvedWslProjectRuntime
    })

    await discoverInstalledAgentSkills(false, { projectRuntime: resolvedHostProjectRuntime })
    expect(discover).toHaveBeenLastCalledWith({
      runtime: 'host',
      projectRuntime: resolvedHostProjectRuntime
    })

    await discoverInstalledAgentSkills(false, { projectRuntime: repairProjectRuntime })
    expect(discover).toHaveBeenLastCalledWith({ projectRuntime: repairProjectRuntime })
  })

  it('keys WSL targets by distro so two distros do not share one entry', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValueOnce(result(1))
      .mockResolvedValueOnce(result(2))
    vi.stubGlobal('window', { api: { skills: { discover } } })

    await expect(
      discoverInstalledAgentSkills(false, { runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toEqual(result(1))
    await expect(
      discoverInstalledAgentSkills(false, { runtime: 'wsl', wslDistro: 'Debian' })
    ).resolves.toEqual(result(2))
    await expect(
      discoverInstalledAgentSkills(false, { runtime: 'wsl', wslDistro: 'Ubuntu' })
    ).resolves.toEqual(result(1))
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('keys targets by runtime and project identity', () => {
    expect(getSkillDiscoveryTargetKey(undefined)).toBe('host')
    expect(getSkillDiscoveryTargetKey({ runtime: 'wsl', wslDistro: 'Ubuntu' })).toBe('wsl:Ubuntu')
    expect(getSkillDiscoveryTargetKey({ projectRuntime: resolvedHostProjectRuntime })).toBe(
      'repo-1:windows-host'
    )
    expect(getSkillDiscoveryTargetKey({ projectRuntime: repairProjectRuntime })).toBe(
      'repo-1:repair:wsl-distro-required:default'
    )
  })
})
