import { parseWslUncPath } from './wsl-paths'
import type { GitCapabilityCache } from './git-capability-cache'
import { resolveWindowsFscacheParallelCheckout } from './windows-parallel-checkout-capability'

const PARALLEL_CHECKOUT_GIT_ARGS = ['-c', 'checkout.workers=-1'] as const

function isWslDrvFsPath(value: string, wslDistro?: string): boolean {
  const parsed = parseWslUncPath(value)
  // A drive-qualified cwd can still be executed by WSL when the caller has
  // explicitly selected a distro (the runner translates C:\\... to
  // /mnt/<drive>/...). Keep the conversion local to this policy helper so
  // callers do not have to change the path passed to Git.
  const driveMatch = value.match(/^([A-Za-z]):[\\/](.*)$/)
  const linuxPath =
    parsed?.linuxPath ??
    (driveMatch && wslDistro?.trim()
      ? `/mnt/${driveMatch[1].toLowerCase()}/${driveMatch[2].replace(/\\/g, '/')}`
      : value)
  // WSL's /mnt/<drive> mounts are DrvFS; unlike ext4, they benefit from the
  // larger pool. Keep this spelling strict so ordinary /mnt-like directories
  // are not silently classified as Windows-backed storage.
  return /^\/mnt\/[a-z](?:\/|$)/.test(linuxPath)
}

function wslParallelCheckoutGitArgs(cwd: string, wslDistro?: string): string[] {
  return isWslDrvFsPath(cwd, wslDistro) ? [...PARALLEL_CHECKOUT_GIT_ARGS] : []
}

// Git for Windows versions before 2.55 can return stale directory entries from
// FSCache while parallel workers are writing. Keep the narrowly scoped workaround
// for native Windows Git; WSL Git uses the Linux filesystem and does not need it.
const NATIVE_WINDOWS_PARALLEL_CHECKOUT_GIT_ARGS = [
  '-c',
  'core.fscache=false',
  ...PARALLEL_CHECKOUT_GIT_ARGS
] as const

export type WindowsParallelCheckoutGitArgsOptions = {
  /** Omit the pre-2.55 FSCache workaround after a verified Git for Windows probe. */
  fscacheSafe?: boolean
  /** Override path inference when a C:\\ path is explicitly routed through WSL. */
  nativeWindowsGit?: boolean
}

function isNativeWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * Enable Git's parallel checkout for native Windows and WSL-routed Git.
 *
 * Git 2.25 (Orca's baseline) ignores the checkout.workers key, so older Git
 * remains sequential without a capability probe. Git for Windows releases
 * before the 2.55 fscache fix can fail when parallel workers observe stale
 * directory listings; disable that cache for native Windows invocations only,
 * without changing the user's config. WSL Git only gets the worker setting on
 * DrvFS paths; ext4 keeps Git's default because parallelism regresses there.
 */
export function windowsParallelCheckoutGitArgs(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  wslDistro?: string,
  options: WindowsParallelCheckoutGitArgsOptions = {}
): string[] {
  if (platform !== 'win32') {
    return []
  }

  // A UNC path under \wsl.localhost/\wsl$ is unambiguously executed by WSL.
  // An explicit distro also marks a WSL route, including POSIX cwd values.
  // Keep native drive/SMB paths on the FSCache-safe argv: linked-worktree
  // routing may deliberately send a C:\ path back to host Git even when a
  // distro override is present.
  if (
    (options.nativeWindowsGit !== true && parseWslUncPath(cwd)) ||
    options.nativeWindowsGit === false ||
    (options.nativeWindowsGit !== true &&
      wslDistro &&
      wslDistro.trim().length > 0 &&
      !isNativeWindowsAbsolutePath(cwd))
  ) {
    return wslParallelCheckoutGitArgs(cwd, wslDistro)
  }
  if (!isNativeWindowsAbsolutePath(cwd)) {
    return []
  }
  return options.fscacheSafe
    ? [...PARALLEL_CHECKOUT_GIT_ARGS]
    : [...NATIVE_WINDOWS_PARALLEL_CHECKOUT_GIT_ARGS]
}

/**
 * Resolve checkout arguments after probing the execution host's Git version.
 *
 * Callers must supply the cache and probe for native Windows Git. Omitting
 * either keeps the pre-2.55 workaround, which is the safe behavior for old
 * callers and for an ambiguous WSL/host route.
 */
export async function windowsParallelCheckoutGitArgsAsync(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  wslDistro?: string,
  options: WindowsParallelCheckoutGitArgsOptions & {
    capabilities?: GitCapabilityCache
    probeGitVersion?: () => Promise<string>
  } = {}
): Promise<string[]> {
  const nativeWindowsGit =
    options.nativeWindowsGit ?? (isNativeWindowsAbsolutePath(cwd) && parseWslUncPath(cwd) === null)
  if (!nativeWindowsGit || platform !== 'win32') {
    return windowsParallelCheckoutGitArgs(cwd, platform, wslDistro, {
      ...options,
      nativeWindowsGit
    })
  }
  if (!options.capabilities || !options.probeGitVersion) {
    return windowsParallelCheckoutGitArgs(cwd, platform, wslDistro, {
      ...options,
      nativeWindowsGit: true
    })
  }
  const fscacheSafe = await resolveWindowsFscacheParallelCheckout(
    options.capabilities,
    options.probeGitVersion
  )
  return windowsParallelCheckoutGitArgs(cwd, platform, wslDistro, {
    ...options,
    nativeWindowsGit: true,
    fscacheSafe
  })
}
