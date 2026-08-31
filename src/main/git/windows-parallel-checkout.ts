import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  windowsParallelCheckoutGitArgsAsync,
  type WindowsParallelCheckoutGitArgsOptions
} from '../../shared/windows-parallel-checkout-git-args'
import { getLocalGitCapabilityCache } from './git-capability-state'
import {
  getWslLinkedWorktreeGitRoute,
  isWslLinkedWorktreeGitRoutingCandidate,
  prepareWslLinkedWorktreeGitRouting
} from './wsl-linked-worktree-git-routing'
import { gitExecFileAsync } from './runner'
import { gitExecOptions, type GitWorktreeExecOptions } from './worktree-operation-options'

const WINDOWS_GIT_VERSION_PROBE_TIMEOUT_MS = 5_000

function isNativeWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

function isWindowsDrivePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value)
}

/**
 * Build checkout args for a local execution host, probing native Windows Git
 * once so Git for Windows 2.55+ can keep FSCache enabled. WSL and ambiguous
 * routes retain the conservative workaround.
 */
export async function resolveLocalWindowsParallelCheckoutGitArgs(
  cwd: string,
  options: GitWorktreeExecOptions & { platform?: NodeJS.Platform; probeCwd?: string } = {}
): Promise<string[]> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') {
    return []
  }

  let nativeWindowsGit = isNativeWindowsAbsolutePath(cwd) && parseWslUncPath(cwd) === null
  // A non-WSL UNC path cannot be classified by the linked-worktree marker
  // walk. With an explicit distro override, keep the old conservative argv
  // instead of probing through whichever host the override selects.
  let routeKnown = !(Boolean(options.wslDistro?.trim()) && !isWindowsDrivePath(cwd))
  let hostRoutedLinkedWorktree = false
  if (
    nativeWindowsGit &&
    isWslLinkedWorktreeGitRoutingCandidate(cwd, options.wslDistro, platform)
  ) {
    try {
      await prepareWslLinkedWorktreeGitRouting(cwd, options.wslDistro, {
        platform,
        signal: options.signal
      })
    } catch (error) {
      if (options.signal?.aborted) {
        throw error
      }
    }
    const route = getWslLinkedWorktreeGitRoute(cwd, options.wslDistro, platform)
    if (route === 'wsl') {
      nativeWindowsGit = false
    } else if (route === 'unknown') {
      // A failed marker probe may still be a host-routed linked worktree.
      // Keep the old safety flag and avoid poisoning either host cache.
      routeKnown = false
    } else if (route === 'host') {
      hostRoutedLinkedWorktree = true
    }
  }

  const baseOptions: WindowsParallelCheckoutGitArgsOptions = {
    nativeWindowsGit
  }
  if (!nativeWindowsGit || !routeKnown) {
    return windowsParallelCheckoutGitArgsAsync(cwd, platform, options.wslDistro, baseOptions)
  }

  // The target/preparation directory may not exist yet. Probe from the
  // repository (or another caller-supplied existing directory), while route
  // classification above intentionally remains tied to the actual target.
  const probeCwd = options.probeCwd ?? cwd
  const capabilities = getLocalGitCapabilityCache(
    nativeWindowsGit ? { cwd: probeCwd } : { cwd: probeCwd, wslDistro: options.wslDistro }
  )
  // A Windows `.git` pointer is an explicit host-Git route even when the
  // caller carries a WSL distro override. Keep the version probe on that same
  // host; probing through WSL would cache a Linux version against the native
  // capability and permanently retain the slower FSCache workaround.
  const probeExecutionOptions = hostRoutedLinkedWorktree
    ? { ...options, wslDistro: undefined }
    : options
  return windowsParallelCheckoutGitArgsAsync(cwd, platform, options.wslDistro, {
    ...baseOptions,
    capabilities,
    probeGitVersion: async () => {
      const result = await gitExecFileAsync(
        ['--version'],
        gitExecOptions(probeCwd, {
          ...probeExecutionOptions,
          // Keep capability detection bounded independently of the much
          // longer worktree operation timeout.
          timeout: WINDOWS_GIT_VERSION_PROBE_TIMEOUT_MS
        })
      )
      return result.stdout
    }
  })
}
