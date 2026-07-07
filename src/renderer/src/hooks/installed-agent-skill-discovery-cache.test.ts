import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SkillDiscoveryResult } from '../../../shared/skills'
import {
  getInstalledAgentSkillDiscoveryCacheSizeForTests,
  hasInstalledAgentSkillDiscoveryCacheEntryForTests,
  INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX,
  INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_TTL_MS,
  peekInstalledAgentSkillDiscoveryCache,
  readInstalledAgentSkillDiscoveryCache,
  resetInstalledAgentSkillDiscoveryCacheForTests,
  writeInstalledAgentSkillDiscoveryCache
} from './installed-agent-skill-discovery-cache'

function result(scannedAt: number): SkillDiscoveryResult {
  return { skills: [], sources: [], scannedAt }
}

afterEach(() => {
  resetInstalledAgentSkillDiscoveryCacheForTests()
  vi.useRealTimers()
})

describe('installed agent skill discovery cache', () => {
  it('stays bounded through prolonged churn and refreshes LRU recency', () => {
    vi.useFakeTimers()
    for (let index = 0; index < INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX; index += 1) {
      writeInstalledAgentSkillDiscoveryCache(`target-${index}`, result(index))
    }

    expect(readInstalledAgentSkillDiscoveryCache('target-0')).toEqual(result(0))
    writeInstalledAgentSkillDiscoveryCache(
      `target-${INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX}`,
      result(INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX)
    )
    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('target-0')).toBe(true)
    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('target-1')).toBe(false)

    for (let index = INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX + 1; index < 10_000; index += 1) {
      writeInstalledAgentSkillDiscoveryCache(`target-${index}`, result(index))
    }

    expect(getInstalledAgentSkillDiscoveryCacheSizeForTests()).toBe(
      INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_MAX
    )
    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('target-9744')).toBe(true)
    expect(hasInstalledAgentSkillDiscoveryCacheEntryForTests('target-9743')).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
  })

  it('expires resolved results and releases the cleanup timer', async () => {
    vi.useFakeTimers()
    writeInstalledAgentSkillDiscoveryCache('target', result(1))

    await vi.advanceTimersByTimeAsync(INSTALLED_AGENT_SKILL_DISCOVERY_CACHE_TTL_MS - 1)
    expect(peekInstalledAgentSkillDiscoveryCache('target')).toEqual(result(1))
    await vi.advanceTimersByTimeAsync(1)

    expect(peekInstalledAgentSkillDiscoveryCache('target')).toBeNull()
    expect(getInstalledAgentSkillDiscoveryCacheSizeForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('clears retained results and the shared cleanup timer', () => {
    vi.useFakeTimers()
    writeInstalledAgentSkillDiscoveryCache('target', result(1))
    resetInstalledAgentSkillDiscoveryCacheForTests()

    expect(getInstalledAgentSkillDiscoveryCacheSizeForTests()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
