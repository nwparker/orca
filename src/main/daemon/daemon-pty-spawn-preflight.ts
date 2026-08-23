import { statSync } from 'node:fs'
import { release } from 'node:os'
import {
  ensureNodePtySpawnHelperExecutable,
  getNodePtySpawnHelperCandidates,
  validateWorkingDirectoryAsync,
  WorkingDirectoryValidationAbortedError
} from '../providers/local-pty-utils'
import { resolveSafePtyDefaultCwd } from '../providers/pty-default-cwd'
import { DaemonProtocolError } from './types'
import { TerminalAttachCanceledError } from './daemon-errors'
import type { DaemonPtyLaunchOptions, DaemonPtyLaunchPlan } from './daemon-pty-launch-plan'

export function resolveDaemonPtyDefaultCwd(): string {
  return resolveSafePtyDefaultCwd()
}

function daemonEnvironmentDiagSuffix(): string {
  const orca = process.env.ORCA_APP_VERSION?.trim() || '0.0.0-dev'
  const systemVersion =
    (process as NodeJS.Process & { getSystemVersion?: () => string }).getSystemVersion?.() ||
    release()
  return ` (orca: ${orca}, arch: ${process.arch}, platform: ${process.platform} ${systemVersion})`
}

function formatMissingDaemonPathError(kind: 'helper' | 'cwd', path: string): DaemonProtocolError {
  const detailName = kind === 'helper' ? 'helper' : 'cwd'
  const step = kind === 'helper' ? 'posix_spawn' : 'daemon_cwd'
  const missingTarget = kind === 'helper' ? 'node-pty install' : 'working directory'
  return new DaemonProtocolError(
    `Daemon's ${missingTarget} is gone (worktree deleted?). Restart Orca. node-pty: ${step} failed: ENOENT (errno 2, No such file or directory) - ${detailName}='${path}'${daemonEnvironmentDiagSuffix()}`
  )
}

export function formatDaemonPtySpawnError(
  err: unknown,
  shellPath: string,
  spawnCwd: string
): Error {
  const message = err instanceof Error ? err.message : String(err)
  const formatted = new DaemonProtocolError(
    `Daemon failed to spawn shell "${shellPath}" with cwd "${spawnCwd}": ${message}${daemonEnvironmentDiagSuffix()}`
  )
  if (err instanceof Error && err.stack) {
    formatted.stack = err.stack
  }
  return formatted
}

export function isExistingDaemonPtyDirectory(path: string | undefined): path is string {
  if (!path) {
    return false
  }
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function repairDaemonCwd(): string | null {
  const candidates = [process.env.ORCA_USER_DATA_PATH]
  try {
    candidates.push(resolveDaemonPtyDefaultCwd())
  } catch {
    // Keep repair best-effort when no user terminal cwd is safe.
  }
  candidates.push(process.platform === 'win32' ? 'C:\\' : '/')
  for (const candidate of candidates) {
    if (!isExistingDaemonPtyDirectory(candidate)) {
      continue
    }
    try {
      process.chdir(candidate)
      return candidate
    } catch {
      // Try the next stable candidate.
    }
  }
  return null
}

function preflightDaemonCwd(): void {
  let daemonCwd = '<unavailable>'
  try {
    daemonCwd = process.cwd()
    if (isExistingDaemonPtyDirectory(daemonCwd)) {
      return
    }
  } catch {
    // Recover below after the original cwd was deleted.
  }
  if (repairDaemonCwd()) {
    return
  }
  throw formatMissingDaemonPathError('cwd', daemonCwd)
}

function preflightMacNodePtySpawnEnvironment(): void {
  if (process.platform !== 'darwin') {
    return
  }
  let candidates: string[]
  try {
    candidates = getNodePtySpawnHelperCandidates()
  } catch {
    throw formatMissingDaemonPathError('helper', '<unresolved>')
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) {
        return
      }
    } catch {
      // Try the next native location.
    }
  }
  throw formatMissingDaemonPathError('helper', candidates[0] ?? '<unresolved>')
}

export function preflightDaemonUnixPtySpawn(): void {
  if (process.platform === 'win32') {
    return
  }
  preflightDaemonCwd()
  preflightMacNodePtySpawnEnvironment()
}

function isNativeWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

async function validateDaemonPtyWorkingDirectory(
  plan: DaemonPtyLaunchPlan,
  opts: DaemonPtyLaunchOptions
): Promise<void> {
  if (process.platform !== 'win32') {
    await validateWorkingDirectoryAsync(
      plan.validationCwd,
      opts.cancelSignal ? { signal: opts.cancelSignal } : {}
    )
    return
  }
  if (opts.cwd === undefined || !isNativeWindowsPath(plan.validationCwd)) {
    return
  }
  await validateWorkingDirectoryAsync(
    plan.validationCwd,
    opts.cancelSignal ? { signal: opts.cancelSignal } : {}
  )
}

export async function preflightDaemonPtySpawn(
  plan: DaemonPtyLaunchPlan,
  opts: DaemonPtyLaunchOptions
): Promise<void> {
  ensureNodePtySpawnHelperExecutable()
  preflightDaemonUnixPtySpawn()
  try {
    await validateDaemonPtyWorkingDirectory(plan, opts)
  } catch (error) {
    if (error instanceof WorkingDirectoryValidationAbortedError) {
      throw new TerminalAttachCanceledError(opts.sessionId)
    }
    throw error
  }
  if (opts.isCanceled?.()) {
    throw new TerminalAttachCanceledError(opts.sessionId)
  }
}
