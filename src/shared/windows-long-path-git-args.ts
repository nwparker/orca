import { parseWslUncPath } from './wsl-paths'

const WINDOWS_LONG_PATH_GIT_ARGS = ['-c', 'core.longpaths=true'] as const

export type WindowsLongPathGitArgsOptions = {
  /** Override path inference when a Windows relay explicitly runs native Git. */
  nativeWindowsGit?: boolean
}

/**
 * Global `git -c` options that let a Windows checkout exceed MAX_PATH.
 *
 * Why command scope: Git for Windows aborts deep checkouts with "Filename too
 * long" unless core.longpaths is on, and `-c` applies it to this invocation
 * only — never `--global`, `--system`, or `--local`, so no user config is
 * written. Available since Git 1.9, well under the 2.25 baseline.
 *
 * Path inference keeps WSL UNC paths off native-only flags; callers with an
 * authoritative native execution boundary can opt back in explicitly.
 */
export function windowsLongPathGitArgs(
  cwd: string,
  platform: NodeJS.Platform = process.platform,
  options: WindowsLongPathGitArgsOptions = {}
): string[] {
  if (platform !== 'win32' || (options.nativeWindowsGit !== true && parseWslUncPath(cwd))) {
    return []
  }
  return [...WINDOWS_LONG_PATH_GIT_ARGS]
}
