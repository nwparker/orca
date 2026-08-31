import { resolveConfiguredRemoteBranchName } from './repo-base-ref-search'
import { gitExecOptions, type GitExec, type LocalGitExecOptions } from './repo-default-base-ref'
import { gitExecFileAsync } from './runner'

export type BranchConflictKind = 'local' | 'remote'

async function hasGitRefAsync(exec: GitExec, ref: string): Promise<boolean> {
  try {
    const { stdout } = await exec(['rev-parse', '--verify', ref])
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

async function listRemoteNamesViaExec(exec: GitExec): Promise<string[]> {
  try {
    const { stdout } = await exec(['remote'])
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)
  } catch {
    return []
  }
}

function parseRefLines(stdout: string): Set<string> {
  return new Set(
    stdout
      .split(/\r?\n/)
      .map((ref) => ref.trim())
      .filter(Boolean)
  )
}

/** Run branch-conflict policy through the host that owns Git execution. */
export async function getBranchConflictKindViaExec(
  exec: GitExec,
  branchName: string,
  allowedBaseRef?: string
): Promise<BranchConflictKind | null> {
  const localRef = `refs/heads/${branchName}`

  // One ref walk can answer both questions. Keeping the remote-name probe in
  // flight removes a WSL/Git process-start interval without changing the
  // configured-remote matching rules below.
  const refsPromise = exec([
    'for-each-ref',
    '--format=%(refname)',
    `refs/heads/${branchName}`,
    'refs/remotes'
  ])
  const remoteNamesPromise = listRemoteNamesViaExec(exec)

  let stdout: string
  try {
    const refsResult = await refsPromise
    stdout = refsResult.stdout
  } catch {
    // Keep the old local-first behavior if the combined read is unavailable.
    // A broken refs walk must not turn an existing local branch into a remote
    // conflict (or make the create path throw).
    return (await hasGitRefAsync(exec, localRef)) ? 'local' : null
  }

  const refs = parseRefLines(stdout)
  if (refs.has(localRef)) {
    return 'local'
  }

  const remoteNames = await remoteNamesPromise
  const hasRemoteConflict = [...refs].some((ref) => {
    if (!ref.startsWith('refs/remotes/')) {
      return false
    }
    if (isAllowedRemoteBaseRef(ref, allowedBaseRef)) {
      return false
    }
    return resolveConfiguredRemoteBranchName(ref, remoteNames) === branchName
  })

  return hasRemoteConflict ? 'remote' : null
}

export function getBranchConflictKind(
  path: string,
  branchName: string,
  allowedBaseRef?: string,
  options: LocalGitExecOptions = {}
): Promise<BranchConflictKind | null> {
  const execOptions = gitExecOptions(path, options)
  return getBranchConflictKindViaExec(
    (argv) => gitExecFileAsync(argv, execOptions),
    branchName,
    allowedBaseRef
  )
}

function isAllowedRemoteBaseRef(refName: string, allowedBaseRef: string | undefined): boolean {
  if (!allowedBaseRef) {
    return false
  }
  const normalizedAllowedRef = allowedBaseRef.startsWith('refs/remotes/')
    ? allowedBaseRef
    : `refs/remotes/${allowedBaseRef}`
  return refName === normalizedAllowedRef
}
