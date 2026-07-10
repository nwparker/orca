import type { GitRuntimeOptions } from './git-runtime-options'
import { gitOptionsForWorktree } from './git-runtime-options'
import { gitExecFileAsync } from './runner'
import {
  encodeGitCheckIgnorePaths,
  GIT_CHECK_IGNORE_STDIN_ARGS,
  GIT_CHECK_IGNORE_TIMEOUT_MS,
  getGitCheckIgnoreMaxBufferBytes,
  parseGitCheckIgnoreOutput
} from '../../shared/git-check-ignore-stdin'

type GitExecError = Error & { stdout?: string; code?: number | string }

export async function checkIgnoredPaths(
  worktreePath: string,
  relativePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  if (relativePaths.length === 0) {
    return []
  }
  const stdin = encodeGitCheckIgnorePaths(relativePaths)
  try {
    const { stdout } = await gitExecFileAsync([...GIT_CHECK_IGNORE_STDIN_ARGS], {
      ...gitOptionsForWorktree(worktreePath, options),
      // Why: File Explorer can check thousands of paths after one filter
      // pause. NUL-delimited stdin keeps this to one process without argv
      // limits and preserves valid filenames containing newlines.
      stdin,
      maxBuffer: getGitCheckIgnoreMaxBufferBytes(stdin),
      timeout: GIT_CHECK_IGNORE_TIMEOUT_MS
    })
    return parseGitCheckIgnoreOutput(stdout)
  } catch (error) {
    const gitError = error as GitExecError
    if (gitError.code === 1) {
      return parseGitCheckIgnoreOutput(gitError.stdout ?? '')
    }
    throw error
  }
}
