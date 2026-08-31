import { parseGitRevListAheadBehindCounts } from '../../shared/git-rev-list-output'
import type {
  LocalBaseRefRefreshResult,
  LocalBaseRefUpdateSuggestion
} from '../../shared/worktree/base-ref-drift-types'
import { gitExecFileAsync, translateWslOutputPaths } from './runner'
import { probeWorktreeBaseRefPresence } from './worktree-base-ref-probe'
import { parseWorktreeList } from './worktree-list-parser'
import type { AddWorktreeOptions, GitWorktreeExecOptions } from './worktree-operation-options'
import { gitExecOptions } from './worktree-operation-options'

type LocalBaseRefRefreshability =
  | {
      refreshable: true
      baseRef: string
      localBranch: string
      fullRef: string
      remoteTrackingRef: string
      localOid: string
      remoteOid: string
      behind: number
      ownerWorktreePath?: string
    }
  | {
      refreshable: false
      result: LocalBaseRefRefreshResult
    }

function parseRemoteTrackingLocalBaseRef(
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase']
): { baseRef: string; localBranch: string; fullRef: string } | undefined {
  if (remoteTrackingBase?.ref === remoteTrackingRef) {
    return {
      baseRef: remoteTrackingBase.base,
      localBranch: remoteTrackingBase.branch,
      fullRef: `refs/heads/${remoteTrackingBase.branch}`
    }
  }

  const remoteRefPrefix = 'refs/remotes/'
  if (!remoteTrackingRef.startsWith(remoteRefPrefix)) {
    return undefined
  }

  // Why: only proven remote-tracking refs get refresh status; slash-containing local branches (release/2026) must not fake a "not refreshed" warning.
  const shortRemoteRef = remoteTrackingRef.slice(remoteRefPrefix.length)
  const slashIndex = shortRemoteRef.indexOf('/')
  if (slashIndex <= 0) {
    return undefined
  }

  const localBranch = shortRemoteRef.slice(slashIndex + 1)
  return {
    baseRef: baseBranch,
    localBranch,
    fullRef: `refs/heads/${localBranch}`
  }
}

function parseRevListDrift(output: string): { ahead: number; behind: number } | null {
  const counts = parseGitRevListAheadBehindCounts(output)
  return counts.status === 'ok' ? { ahead: counts.ahead, behind: counts.behind } : null
}

// `rev-parse --verify` is a cheap read on POSIX, but each invocation still pays
// a wsl.exe/Windows process start. Keep the format to atoms available in Git
// 2.25 (Orca's baseline) and read both OIDs in one process on those hosts.
const LOCAL_BASE_OID_BATCH_FORMAT =
  '%(refname)%00%(objectname)%00%(objecttype)%00%(*objectname)%00%(*objecttype)%00%(symref)'

type BatchedRefOidRecord = {
  ref: string
  objectName: string
  objectType: string
  peeledObjectName: string
  peeledObjectType: string
  symref: string
}

type BatchedRefOids = { localOid: string; remoteOid: string }

function isWindowsOrWslExecution(options: GitWorktreeExecOptions): boolean {
  return process.platform === 'win32' || Boolean(options.wslDistro?.trim())
}

function isPlausibleObjectName(value: string): boolean {
  // SHA-1 is 40 chars and SHA-256 is 64; accepting a bounded even-length hex
  // token leaves room for future Git object formats without accepting shell text.
  return (
    value.length >= 4 && value.length <= 128 && value.length % 2 === 0 && /^[0-9a-f]+$/i.test(value)
  )
}

function parseBatchedRefOidRecords(stdout: string): BatchedRefOidRecord[] | undefined {
  const records: BatchedRefOidRecord[] = []
  for (const line of stdout.split(/\r?\n/)) {
    if (line.length === 0) {
      continue
    }
    const fields = line.split('\0')
    // A shell banner, truncated output, or an old Git that echoed the format
    // must never be mistaken for an OID. Fall back to the proven rev-parse path.
    if (fields.length !== 6) {
      return undefined
    }
    const [ref, objectName, objectType, peeledObjectName, peeledObjectType, symref] = fields
    if (!ref || !objectName || !objectType || symref.includes('\n') || symref.includes('\r')) {
      return undefined
    }
    if (!isPlausibleObjectName(objectName)) {
      return undefined
    }
    if (peeledObjectName && !isPlausibleObjectName(peeledObjectName)) {
      return undefined
    }
    records.push({ ref, objectName, objectType, peeledObjectName, peeledObjectType, symref })
  }
  return records
}

function objectNameForCommitRecord(record: BatchedRefOidRecord): string | undefined {
  if (record.objectType === 'commit') {
    return record.objectName
  }
  if (record.peeledObjectType === 'commit' && record.peeledObjectName) {
    return record.peeledObjectName
  }
  return undefined
}

function parseBatchedRefOids(
  stdout: string,
  localRef: string,
  remoteRef: string
): BatchedRefOids | undefined {
  const records = parseBatchedRefOidRecords(stdout)
  if (!records) {
    return undefined
  }
  const byRef = new Map<string, BatchedRefOidRecord>()
  for (const record of records) {
    // `for-each-ref refs/heads/foo` also returns refs below that prefix. Ignore
    // those valid siblings and require an exact record for each requested ref.
    if (record.ref !== localRef && record.ref !== remoteRef) {
      continue
    }
    if (byRef.has(record.ref)) {
      return undefined
    }
    byRef.set(record.ref, record)
  }
  const localRecord = byRef.get(localRef)
  const remoteRecord = byRef.get(remoteRef)
  const localOid = localRecord ? objectNameForCommitRecord(localRecord) : undefined
  const remoteOid = remoteRecord ? objectNameForCommitRecord(remoteRecord) : undefined
  return localOid && remoteOid ? { localOid, remoteOid } : undefined
}

async function resolveLocalAndRemoteOids(
  exec: (args: string[]) => Promise<{ stdout: string }>,
  localRef: string,
  remoteRef: string,
  options: GitWorktreeExecOptions
): Promise<{ localOid: string; remoteOid: string }> {
  if (isWindowsOrWslExecution(options)) {
    try {
      const { stdout } = await exec([
        'for-each-ref',
        `--format=${LOCAL_BASE_OID_BATCH_FORMAT}`,
        localRef,
        remoteRef
      ])
      const batched = parseBatchedRefOids(stdout, localRef, remoteRef)
      if (batched) {
        return batched
      }
    } catch {
      // Fall through to the compatibility path below.
    }
  }

  const [{ stdout: localOidOutput }, { stdout: remoteOidOutput }] = await Promise.all([
    exec(['rev-parse', '--verify', `${localRef}^{commit}`]),
    exec(['rev-parse', '--verify', `${remoteRef}^{commit}`])
  ])
  return { localOid: localOidOutput.trim(), remoteOid: remoteOidOutput.trim() }
}

export async function evaluateLocalBaseRefRefreshability(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {},
  shouldInspectOwner: (behind: number) => boolean = () => true
): Promise<LocalBaseRefRefreshability | undefined> {
  const parsed = parseRemoteTrackingLocalBaseRef(baseBranch, remoteTrackingRef, remoteTrackingBase)
  if (!parsed) {
    return undefined
  }

  const resultBase = { baseRef: parsed.baseRef, localBranch: parsed.localBranch }

  let drift: { ahead: number; behind: number }
  let localOid = ''
  let remoteOid = ''
  try {
    // Why: advisory and mutating paths must agree on "safe to fast-forward"; `rev-list A...B` proves no local-only commits and how far behind.
    const { stdout } = await gitExecFileAsync(
      ['rev-list', '--left-right', '--count', `${parsed.fullRef}...${remoteTrackingRef}`],
      gitExecOptions(repoPath, options)
    )
    const parsedDrift = parseRevListDrift(stdout)
    if (!parsedDrift || parsedDrift.ahead !== 0) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    if (!shouldInspectOwner(parsedDrift.behind)) {
      // Why: a current local ref yields no update suggestion, so the advisory path skips OID resolution and owner inspection.
      return undefined
    }
    const { localOid: resolvedLocalOid, remoteOid: resolvedRemoteOid } =
      await resolveLocalAndRemoteOids(
        (args) => gitExecFileAsync(args, gitExecOptions(repoPath, options)),
        parsed.fullRef,
        remoteTrackingRef,
        options
      )
    localOid = resolvedLocalOid
    remoteOid = resolvedRemoteOid
    if (!localOid) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    if (!remoteOid) {
      return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
    }
    await gitExecFileAsync(
      ['merge-base', '--is-ancestor', localOid, remoteOid],
      gitExecOptions(repoPath, options)
    )
    drift = parsedDrift
  } catch {
    // Why (#15331): the probes above also fail when refs/heads/<branch> is simply absent; a branch that
    // does not exist yet cannot be stale, so report nothing instead of a bogus divergence warning.
    // Only a proven absence suppresses: an unusable repo leaves the warning alone.
    const presence = await probeWorktreeBaseRefPresence(
      (args) => gitExecFileAsync(args, gitExecOptions(repoPath, options)),
      parsed.fullRef
    )
    if (presence === 'absent') {
      return undefined
    }
    return { refreshable: false, result: { ...resultBase, status: 'skipped_not_fast_forward' } }
  }

  try {
    // Why: if the local base branch is checked out, only update it when that owner worktree is clean.
    const { stdout: worktreeListOutput } = await gitExecFileAsync(
      ['worktree', 'list', '--porcelain'],
      gitExecOptions(repoPath, options)
    )
    const worktrees = parseWorktreeList(
      translateWslOutputPaths(worktreeListOutput, repoPath, options)
    )
    const ownerWorktree = worktrees.find((wt) => wt.branch === parsed.fullRef)

    if (ownerWorktree) {
      const { stdout: status } = await gitExecFileAsync(
        ['status', '--porcelain', '--untracked-files=no'],
        gitExecOptions(ownerWorktree.path, options)
      )
      if (status.trim()) {
        return {
          refreshable: false,
          result: {
            ...resultBase,
            status: 'skipped_dirty_worktree',
            ownerWorktreePath: ownerWorktree.path
          }
        }
      }
      return {
        refreshable: true,
        ...resultBase,
        fullRef: parsed.fullRef,
        remoteTrackingRef,
        localOid,
        remoteOid,
        behind: drift.behind,
        ownerWorktreePath: ownerWorktree.path
      }
    }

    // Why: localBranch isn't checked out anywhere, so a bare-ref fast-forward is safe; omitting ownerWorktreePath signals the mutating path to take it.
    return {
      refreshable: true,
      ...resultBase,
      fullRef: parsed.fullRef,
      remoteTrackingRef,
      localOid,
      remoteOid,
      behind: drift.behind
    }
  } catch {
    return { refreshable: false, result: { ...resultBase, status: 'skipped_error' } }
  }
}

export async function getLocalBaseRefUpdateSuggestionForWorktreeCreate(
  repoPath: string,
  baseBranch: string,
  remoteTrackingRef: string,
  remoteTrackingBase?: AddWorktreeOptions['remoteTrackingBase'],
  options: GitWorktreeExecOptions = {}
): Promise<LocalBaseRefUpdateSuggestion | undefined> {
  const evaluation = await evaluateLocalBaseRefRefreshability(
    repoPath,
    baseBranch,
    remoteTrackingRef,
    remoteTrackingBase,
    options,
    (behind) => behind > 0
  )
  if (!evaluation?.refreshable || evaluation.behind <= 0) {
    return undefined
  }
  return {
    baseRef: evaluation.baseRef,
    localBranch: evaluation.localBranch,
    behind: evaluation.behind
  }
}
