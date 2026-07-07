import type { SkillDiscoveryResult } from '../../../shared/skills'

type InstalledAgentSkillDiscoveryCacheEntry = {
  expiresAt: number
  result: SkillDiscoveryResult
}

export const INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX = 256
export const INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_TTL_MS = 5 * 60_000

let cachedDiscoveryByTarget = new Map<string, InstalledAgentSkillDiscoveryCacheEntry>()
let expiryTimer: ReturnType<typeof setTimeout> | null = null

export function peekInstalledAgentSkillDiscoveryCache(key: string): SkillDiscoveryResult | null {
  const entry = cachedDiscoveryByTarget.get(key)
  return entry && entry.expiresAt > Date.now() ? entry.result : null
}

export function readInstalledAgentSkillDiscoveryCache(key: string): SkillDiscoveryResult | null {
  const entry = cachedDiscoveryByTarget.get(key)
  if (!entry) {
    return null
  }
  if (entry.expiresAt <= Date.now()) {
    cachedDiscoveryByTarget.delete(key)
    return null
  }
  cachedDiscoveryByTarget.delete(key)
  cachedDiscoveryByTarget.set(key, entry)
  return entry.result
}

export function writeInstalledAgentSkillDiscoveryCache(
  key: string,
  result: SkillDiscoveryResult
): void {
  cachedDiscoveryByTarget.delete(key)
  cachedDiscoveryByTarget.set(key, {
    expiresAt: Date.now() + INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_TTL_MS,
    result
  })
  // Why: project and runtime identities change during long renderer sessions;
  // keep recent discovery results without retaining every target ever opened.
  while (cachedDiscoveryByTarget.size > INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX) {
    const oldest = cachedDiscoveryByTarget.keys().next().value
    if (oldest === undefined) {
      break
    }
    cachedDiscoveryByTarget.delete(oldest)
  }
  scheduleExpiry()
}

export function clearInstalledAgentSkillDiscoveryCache(): void {
  cachedDiscoveryByTarget.clear()
  clearExpiryTimer()
}

export function getInstalledAgentSkillDiscoveryCacheSizeForTests(): number {
  return cachedDiscoveryByTarget.size
}

export function hasInstalledAgentSkillDiscoveryCacheEntryForTests(key: string): boolean {
  return cachedDiscoveryByTarget.has(key)
}

export function resetInstalledAgentSkillDiscoveryCacheForTests(): void {
  clearInstalledAgentSkillDiscoveryCache()
  cachedDiscoveryByTarget = new Map()
}

function clearExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
}

function scheduleExpiry(): void {
  if (expiryTimer !== null) {
    return
  }
  let nextExpiryAt = Number.POSITIVE_INFINITY
  for (const entry of cachedDiscoveryByTarget.values()) {
    nextExpiryAt = Math.min(nextExpiryAt, entry.expiresAt)
  }
  if (!Number.isFinite(nextExpiryAt)) {
    return
  }
  expiryTimer = setTimeout(expireIdleEntries, Math.max(0, nextExpiryAt - Date.now()))
}

function expireIdleEntries(): void {
  expiryTimer = null
  const now = Date.now()
  for (const [key, entry] of cachedDiscoveryByTarget) {
    if (entry.expiresAt <= now) {
      cachedDiscoveryByTarget.delete(key)
    }
  }
  scheduleExpiry()
}
