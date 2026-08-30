import { gitExecFileAsync, gitExecFileSync } from './runner'

export type LocalGitExecOptions = {
  wslDistro?: string
}

export type LocalDefaultBaseRefGitOptions = {
  cwd: string
  wslDistro?: string
}

export const DEFAULT_BASE_REF_PROBE_TIMEOUT_MS = 15_000

export function gitExecOptions(
  cwd: string,
  options: LocalGitExecOptions = {}
): { cwd: string; wslDistro?: string } {
  return options.wslDistro ? { cwd, wslDistro: options.wslDistro } : { cwd }
}

export const DEFAULT_BASE_REF_PROBES: readonly { ref: string; returnAs: string }[] = [
  { ref: 'refs/remotes/origin/main', returnAs: 'origin/main' },
  { ref: 'refs/remotes/origin/master', returnAs: 'origin/master' },
  { ref: 'refs/heads/main', returnAs: 'main' },
  { ref: 'refs/heads/master', returnAs: 'master' }
]

async function resolveDefaultBaseRefFromProbes(
  hasRef: (ref: string) => Promise<boolean>
): Promise<string | null> {
  for (const { ref, returnAs } of DEFAULT_BASE_REF_PROBES) {
    if (await hasRef(ref)) {
      return returnAs
    }
  }
  return null
}

/** Probe the conventional refs in one Git process; retain the old loop as a fallback. */
async function resolveDefaultBaseRefFromBatchedProbes(exec: GitExec): Promise<string | null> {
  try {
    const { stdout } = await exec([
      'for-each-ref',
      '--format=%(refname)',
      ...DEFAULT_BASE_REF_PROBES.map(({ ref }) => ref)
    ])
    const refs = new Set(
      stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => DEFAULT_BASE_REF_PROBES.some(({ ref }) => ref === line))
    )
    return DEFAULT_BASE_REF_PROBES.find(({ ref }) => refs.has(ref))?.returnAs ?? null
  } catch {
    return resolveDefaultBaseRefFromProbes((ref) => hasGitRefViaExec(exec, ref))
  }
}

function hasGitRef(path: string, ref: string): boolean {
  try {
    gitExecFileSync(['rev-parse', '--verify', ref], { cwd: path })
    return true
  } catch {
    return false
  }
}

function gitRefToDefaultBaseRef(ref: string): string {
  return ref.replace(/^refs\/remotes\//, '')
}

function getVerifiedOriginHeadBaseRef(path: string): string | null {
  try {
    const ref = gitExecFileSync(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], {
      cwd: path
    }).trim()
    return ref && hasGitRef(path, ref) ? gitRefToDefaultBaseRef(ref) : null
  } catch {
    return null
  }
}

/** Resolve the default base ref without inventing a fallback branch. */
export function getDefaultBaseRef(path: string): string | null {
  const originHeadBaseRef = getVerifiedOriginHeadBaseRef(path)
  if (originHeadBaseRef) {
    return originHeadBaseRef
  }
  for (const { ref, returnAs } of DEFAULT_BASE_REF_PROBES) {
    if (hasGitRef(path, ref)) {
      return returnAs
    }
  }
  return null
}

export async function getBaseRefDefault(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string | null> {
  return getDefaultBaseRefAsync(path, options)
}

export type GitExec = (argv: string[]) => Promise<{ stdout: string }>

async function hasGitRefViaExec(exec: GitExec, ref: string): Promise<boolean> {
  try {
    await exec(['rev-parse', '--verify', '--quiet', ref])
    return true
  } catch {
    return false
  }
}

async function resolveVerifiedOriginHeadBaseRefViaExec(exec: GitExec): Promise<string | null> {
  try {
    const { stdout } = await exec(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
    const ref = stdout.trim()
    if (!ref || !(await hasGitRefViaExec(exec, ref))) {
      return null
    }
    return gitRefToDefaultBaseRef(ref)
  } catch {
    return null
  }
}

/** Resolve the same default-base ordering through a host-owned Git executor. */
export async function resolveDefaultBaseRefViaExec(exec: GitExec): Promise<string | null> {
  const originHeadBaseRef = await resolveVerifiedOriginHeadBaseRefViaExec(exec)
  if (originHeadBaseRef) {
    return originHeadBaseRef
  }
  return resolveDefaultBaseRefFromProbes((ref) => hasGitRefViaExec(exec, ref))
}

export function resolveDefaultBaseRefWithLocalGit(
  options: LocalDefaultBaseRefGitOptions
): Promise<string | null> {
  const exec = (argv: string[]) =>
    gitExecFileAsync(argv, {
      ...options,
      timeout: DEFAULT_BASE_REF_PROBE_TIMEOUT_MS
    })
  // WSL process startup makes the four fallback probes visible in create latency.
  return options.wslDistro
    ? resolveDefaultBaseRefViaExecWithBatchedProbes(exec)
    : resolveDefaultBaseRefViaExec(exec)
}

async function resolveDefaultBaseRefViaExecWithBatchedProbes(
  exec: GitExec
): Promise<string | null> {
  const originHeadBaseRef = await resolveVerifiedOriginHeadBaseRefViaExec(exec)
  if (originHeadBaseRef) {
    return originHeadBaseRef
  }
  return resolveDefaultBaseRefFromBatchedProbes(exec)
}

export function getDefaultBaseRefAsync(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string | null> {
  return resolveDefaultBaseRefWithLocalGit(gitExecOptions(path, options))
}
