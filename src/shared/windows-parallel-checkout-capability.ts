import type { GitCapabilityCache } from './git-capability-cache'

/** Git for Windows fixed stale directory listings during parallel checkout in 2.55. */
export const WINDOWS_FSCACHE_PARALLEL_CHECKOUT_CAPABILITY =
  'windows-fscache-parallel-checkout' as const

export type GitForWindowsVersion = {
  major: number
  minor: number
  patch: number
  build: number | null
}

// Keep this deliberately narrow: a native Windows Git version is the only
// evidence that permits omitting the old FSCache workaround.
const GIT_FOR_WINDOWS_VERSION_RE =
  /^git version (\d+)\.(\d+)(?:\.(\d+))?\.windows(?:\.(\d+))?(?:\s+\([^\r\n]*\))?$/i

/**
 * Parse the one-line version emitted by Git for Windows.
 *
 * Non-Windows Git, malformed output, and output contaminated by a shell
 * banner all return null so callers retain the conservative workaround.
 */
export function parseGitForWindowsVersion(output: string): GitForWindowsVersion | null {
  const normalized = output.trim()
  if (normalized.includes('\n') || normalized.includes('\r')) {
    return null
  }
  const match = GIT_FOR_WINDOWS_VERSION_RE.exec(normalized)
  if (!match) {
    return null
  }
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3] ?? 0)
  const build = match[4] === undefined ? null : Number(match[4])
  if (
    ![major, minor, patch].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    (build !== null && (!Number.isSafeInteger(build) || build < 0))
  ) {
    return null
  }
  return { major, minor, patch, build }
}

/** True only for Git for Windows 2.55 or newer. */
export function supportsWindowsFscacheParallelCheckout(output: string): boolean {
  const version = parseGitForWindowsVersion(output)
  return version !== null && (version.major > 2 || (version.major === 2 && version.minor >= 55))
}

// `CapabilityProbeCache.runWithFallback` intentionally re-runs the preferred
// callback after a positive probe. Version probing returns a value, so retain
// that value separately while still using the shared support/retry semantics.
const supportedValueByCache = new WeakMap<GitCapabilityCache, true>()
const inFlightByCache = new WeakMap<GitCapabilityCache, Promise<boolean>>()

/**
 * Resolve whether this execution host's Git can safely use its default
 * FSCache during parallel checkout. Failures and unknown versions fail closed.
 * Concurrent callers share one `git --version` subprocess per capability cache.
 */
export async function resolveWindowsFscacheParallelCheckout(
  capabilities: GitCapabilityCache,
  probeGitVersion: () => Promise<string>
): Promise<boolean> {
  // A caller may clear and reuse a cache in tests or after host reinitializing;
  // never let the side-map outlive the cache's support state.
  if (supportedValueByCache.has(capabilities)) {
    if (capabilities.isKnownSupported(WINDOWS_FSCACHE_PARALLEL_CHECKOUT_CAPABILITY)) {
      return true
    }
    supportedValueByCache.delete(capabilities)
  }
  if (!capabilities.shouldTry(WINDOWS_FSCACHE_PARALLEL_CHECKOUT_CAPABILITY)) {
    return false
  }
  const existing = inFlightByCache.get(capabilities)
  if (existing) {
    return existing
  }

  let probe!: Promise<boolean>
  probe = (async (): Promise<boolean> => {
    try {
      const safe = supportsWindowsFscacheParallelCheckout(await probeGitVersion())
      if (safe) {
        supportedValueByCache.set(capabilities, true)
        capabilities.rememberSupported(WINDOWS_FSCACHE_PARALLEL_CHECKOUT_CAPABILITY)
      } else {
        capabilities.rememberUnsupported(WINDOWS_FSCACHE_PARALLEL_CHECKOUT_CAPABILITY)
      }
      return safe
    } catch {
      // Unknown, timed out, or cancelled probes must not remove a safety flag.
      capabilities.rememberUnsupported(WINDOWS_FSCACHE_PARALLEL_CHECKOUT_CAPABILITY)
      return false
    } finally {
      if (inFlightByCache.get(capabilities) === probe) {
        inFlightByCache.delete(capabilities)
      }
    }
  })()
  inFlightByCache.set(capabilities, probe)
  return probe
}
