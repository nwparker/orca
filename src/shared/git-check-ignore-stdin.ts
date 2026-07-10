export const GIT_CHECK_IGNORE_STDIN_ARGS = [
  '-c',
  'core.quotePath=false',
  'check-ignore',
  '--stdin',
  '-z'
] as const
export const GIT_CHECK_IGNORE_TIMEOUT_MS = 15_000
const GIT_CHECK_IGNORE_MIN_MAX_BUFFER_BYTES = 10 * 1024 * 1024

export function encodeGitCheckIgnorePaths(paths: readonly string[]): string {
  return paths.length > 0 ? `${paths.join('\0')}\0` : ''
}

export function getGitCheckIgnoreMaxBufferBytes(stdin: string): number {
  // UTF-8 needs at most four bytes per UTF-16 code unit. Scale the output cap
  // with the already-bounded request so one-process checks do not regress huge
  // repos that previously emitted through many independent 10 MiB chunks.
  return Math.max(GIT_CHECK_IGNORE_MIN_MAX_BUFFER_BYTES, stdin.length * 4)
}

export function parseGitCheckIgnoreOutput(stdout: string): string[] {
  return [...new Set(stdout.split('\0').filter(Boolean))]
}
