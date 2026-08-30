import { parseWslUncPath } from './wsl-paths'

const WINDOWS_PARALLEL_CHECKOUT_GIT_ARGS = [
  '-c',
  'core.fscache=false',
  '-c',
  'checkout.workers=-1'
] as const

function isNativeWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * Enable Git's parallel checkout only for a native Windows Git invocation.
 *
 * Git 2.25 (Orca's baseline) ignores the checkout.workers key, so older Git
 * remains sequential without a capability probe. Git for Windows releases
 * before the 2.55 fscache fix can fail when parallel workers observe stale
 * directory listings; disable that cache for this invocation to keep those
 * releases correct without changing the user's config. WSL paths and
 * explicit WSL routing stay untouched because their filesystem/runtime has
 * different costs.
 */
export function windowsParallelCheckoutGitArgs(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  wslDistro?: string
): string[] {
  if (
    platform !== 'win32' ||
    !isNativeWindowsAbsolutePath(cwd) ||
    parseWslUncPath(cwd) ||
    wslDistro
  ) {
    return []
  }
  return [...WINDOWS_PARALLEL_CHECKOUT_GIT_ARGS]
}
