import type { SkillDiscoveryResult, SkillDiscoveryTarget } from '../../../shared/skills'
import {
  clearInstalledAgentSkillDiscoveryCache,
  readInstalledAgentSkillDiscoveryCache,
  resetInstalledAgentSkillDiscoveryCacheForTests,
  writeInstalledAgentSkillDiscoveryCache
} from './installed-agent-skill-discovery-cache'

let discoveryGeneration = 0
let pendingDiscoveryByTarget = new Map<string, Promise<SkillDiscoveryResult>>()
let pendingDiscoverySatisfiesForcedRefreshByTarget = new Map<string, boolean>()

export function invalidateInstalledAgentSkillDiscovery(): void {
  discoveryGeneration += 1
  clearInstalledAgentSkillDiscoveryCache()
  // Why: an install/uninstall must start a post-mutation scan; older pending
  // reads may finish, but their generation can no longer repopulate the cache.
  pendingDiscoveryByTarget.clear()
  pendingDiscoverySatisfiesForcedRefreshByTarget.clear()
}

export async function discoverInstalledAgentSkills(
  force: boolean,
  target?: SkillDiscoveryTarget
): Promise<SkillDiscoveryResult> {
  const key = getSkillDiscoveryTargetKey(target)
  if (!force) {
    // Why: only a cache-serving read should refresh recency — a forced refresh
    // discards the entry it would otherwise promote.
    const cachedDiscovery = readInstalledAgentSkillDiscoveryCache(key)
    if (cachedDiscovery) {
      return cachedDiscovery
    }
  }

  const inFlightDiscovery = pendingDiscoveryByTarget.get(key)
  if (inFlightDiscovery) {
    if (!force || pendingDiscoverySatisfiesForcedRefreshByTarget.get(key)) {
      return inFlightDiscovery
    }
    try {
      await inFlightDiscovery
    } catch {
      // Why: an explicit re-check should still read current disk state even if
      // the older background scan failed.
    }
    const nextPendingDiscovery = pendingDiscoveryByTarget.get(key)
    if (nextPendingDiscovery && nextPendingDiscovery !== inFlightDiscovery) {
      return nextPendingDiscovery
    }
  }

  return startInstalledAgentSkillDiscovery(force, target, key)
}

export function getSkillDiscoveryTargetKey(target: SkillDiscoveryTarget | undefined): string {
  if (target?.projectRuntime) {
    return target.projectRuntime.status === 'resolved'
      ? target.projectRuntime.runtime.cacheKey
      : target.projectRuntime.repair.cacheKey
  }
  const normalizedTarget = normalizeSkillDiscoveryTarget(target)
  return normalizedTarget?.runtime === 'wsl' ? `wsl:${normalizedTarget.wslDistro ?? ''}` : 'host'
}

export function resetInstalledAgentSkillDiscoveryForTests(): void {
  invalidateInstalledAgentSkillDiscovery()
  resetInstalledAgentSkillDiscoveryCacheForTests()
  pendingDiscoveryByTarget = new Map()
  pendingDiscoverySatisfiesForcedRefreshByTarget = new Map()
}

function normalizeSkillDiscoveryTarget(
  target: SkillDiscoveryTarget | undefined
): SkillDiscoveryTarget | undefined {
  const projectRuntime = target?.projectRuntime
  if (projectRuntime) {
    if (projectRuntime.status === 'repair-required') {
      return { projectRuntime }
    }
    if (projectRuntime.runtime.kind === 'wsl') {
      return {
        runtime: 'wsl',
        wslDistro: projectRuntime.runtime.distro,
        projectRuntime
      }
    }
    return { runtime: 'host', projectRuntime }
  }

  if (target?.runtime !== 'wsl') {
    return undefined
  }
  return { runtime: 'wsl', wslDistro: target.wslDistro?.trim() || null }
}

function startInstalledAgentSkillDiscovery(
  force: boolean,
  target: SkillDiscoveryTarget | undefined,
  key: string
): Promise<SkillDiscoveryResult> {
  const generation = discoveryGeneration
  const normalizedTarget = normalizeSkillDiscoveryTarget(target)
  const discovery = window.api.skills
    .discover(normalizedTarget)
    .then((result) => {
      if (generation === discoveryGeneration) {
        writeInstalledAgentSkillDiscoveryCache(key, result)
      }
      return result
    })
    .finally(() => {
      if (pendingDiscoveryByTarget.get(key) === discovery) {
        pendingDiscoveryByTarget.delete(key)
        pendingDiscoverySatisfiesForcedRefreshByTarget.delete(key)
      }
    })
  pendingDiscoveryByTarget.set(key, discovery)
  pendingDiscoverySatisfiesForcedRefreshByTarget.set(key, force)
  return discovery
}
