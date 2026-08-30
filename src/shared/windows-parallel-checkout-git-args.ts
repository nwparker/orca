import { parseWslUncPath } from './wsl-paths'

const WINDOWS_PARALLEL_CHECKOUT_GIT_ARGS = ['-c', 'checkout.workers=-1'] as const

function isNativeWindowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
}

/**
 * Enable Git's parallel checkout only for a native Windows Git invocation.
 *
 * Git 2.25 (Orca's baseline) ignores this unknown config key, so older Git
 * remains sequential without a capability probe. WSL paths and explicit WSL
 * routing stay untouched because their filesystem/runtime has different costs.
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
