import { gitExecFileAsync, gitExecFileSync } from './runner'
import { parseWslUncPath } from '../../shared/wsl-paths'

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

const ORIGIN_HEAD_REF = 'refs/remotes/origin/HEAD'
// `%(symref)` and `%(objecttype)` are available in Git 2.25 (Orca's baseline).
// NUL separators are safe because Git refnames cannot contain NUL or newlines.
const DEFAULT_BASE_REF_BATCH_FORMAT = '%(refname)%00%(symref)%00%(objecttype)%00%(*objecttype)'

type BatchedRefRecord = {
  ref: string
  symref: string
  objectType: string
  peeledObjectType: string
}

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

function parseBatchedRefRecords(stdout: string): BatchedRefRecord[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.split('\0'))
    .filter((fields) => fields.length >= 4 && fields[0])
    .map(([ref, symref, objectType, peeledObjectType]) => ({
      ref,
      symref,
      objectType,
      peeledObjectType
    }))
}

function isCommitLikeRecord(record: BatchedRefRecord): boolean {
  // A symbolic ref can point at an annotated tag; `rev-parse <ref>^{commit}`
  // accepts that shape, so accept both direct and peeled commit objects.
  return record.objectType === 'commit' || record.peeledObjectType === 'commit'
}

/** Probe origin/HEAD and conventional refs in one Git process; retain the old loop as a fallback. */
async function resolveDefaultBaseRefFromBatchedProbes(exec: GitExec): Promise<string | null> {
  try {
    const { stdout } = await exec([
      'for-each-ref',
      `--format=${DEFAULT_BASE_REF_BATCH_FORMAT}`,
      ORIGIN_HEAD_REF,
      ...DEFAULT_BASE_REF_PROBES.map(({ ref }) => ref)
    ])
    const records = parseBatchedRefRecords(stdout)
    const originHead = records.find((record) => record.ref === ORIGIN_HEAD_REF)
    if (originHead?.symref && isCommitLikeRecord(originHead)) {
      return gitRefToDefaultBaseRef(originHead.symref)
    }
    const refs = new Set(records.map((record) => record.ref))
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
  // WSL process startup makes the fallback probes visible in create latency. A
  // UNC repo carries its distro in the path, so do not require callers to repeat
  // that hint in options (the runner derives it the same way).
  const isWslRouted =
    Boolean(options.wslDistro?.trim()) ||
    (process.platform === 'win32' && parseWslUncPath(options.cwd) !== null)
  return isWslRouted
    ? resolveDefaultBaseRefViaExecWithBatchedProbes(exec)
    : resolveDefaultBaseRefViaExec(exec)
}

async function resolveDefaultBaseRefViaExecWithBatchedProbes(
  exec: GitExec
): Promise<string | null> {
  return resolveDefaultBaseRefFromBatchedProbes(exec)
}

export function getDefaultBaseRefAsync(
  path: string,
  options: LocalGitExecOptions = {}
): Promise<string | null> {
  return resolveDefaultBaseRefWithLocalGit(gitExecOptions(path, options))
}
