/* eslint-disable max-lines -- Why: the collector's platform-specific
   enumeration paths (`ps` on Unix, `wmic` on Windows) plus the history
   ring buffer plus the Electron bucketing live together to keep one
   snapshot's worth of code in one place. Splitting them produces extra
   modules whose only consumer is this file. */
/**
 * Memory dashboard collector.
 *
 * One snapshot covers two sources:
 *   - Orca's own Electron processes, via `app.getAppMetrics()`, bucketed
 *     into main / renderer / other.
 *   - Each registered PTY's process subtree, enumerated once from a host-
 *     wide `ps` sweep (`wmic` on Windows).
 *
 * Memory samples are held in a per-key ring (one key per worktree, plus
 * a reserved app-total key) so the UI can draw a trend sparkline.
 *
 * Concurrent callers coalesce onto a single in-flight sweep so a burst of
 * renderer polls never produces overlapping child processes.
 */

import { basename, join } from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'
import { app } from 'electron'
import type {
  AppMemory,
  MemorySnapshot,
  HostMemory,
  ProcessMemoryDetail,
  SessionMemory,
  WorktreeMemory
} from '../../shared/types'
import type { Store } from '../persistence'
import { ORPHAN_WORKTREE_ID } from '../../shared/constants'
import { listRegisteredPtys } from './pty-registry'
import { getDaemonSocketPath, getDaemonTokenPath } from '../daemon/daemon-spawner'

export type MemorySnapshotStore = Pick<Store, 'getRepo' | 'getWorktreeMeta'>

// ─── Module state ───────────────────────────────────────────────────

let inflight: Promise<MemorySnapshot> | null = null

// ─── Public API ─────────────────────────────────────────────────────

export async function collectMemorySnapshot(store: MemorySnapshotStore): Promise<MemorySnapshot> {
  // Why: coalescing relies on the persistence store being a process-wide
  // singleton at runtime. Concurrent callers all hand in the same instance,
  // so it is safe to return the existing in-flight promise (which was
  // kicked off with that same store) rather than starting a second sweep.
  if (inflight) {
    return inflight
  }
  inflight = runSnapshot(store)
    .catch((err) => {
      console.warn('[memory] snapshot failed; returning empty', err)
      return emptySnapshot()
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

// ─── Internals ──────────────────────────────────────────────────────

const execAsync = promisify(exec)
const PS_EXEC_TIMEOUT_MS = 5_000
const PS_MAX_BUFFER = 10 * 1024 * 1024

/** One row from the host-wide process listing. */
type ProcRow = {
  pid: number
  ppid: number
  /** Percent of one core (may exceed 100 on multi-core). 0 on Windows. */
  cpu: number
  /** Resident memory in bytes. */
  memory: number
  command: string | null
  name: string | null
}

/** Indexed view of a single `ps`/`wmic` sweep. */
type ProcIndex = {
  byPid: Map<number, ProcRow>
  childrenOf: Map<number, number[]>
}

function clampNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, value)
}

function hostMetrics(): HostMemory {
  const total = clampNumber(os.totalmem())
  const free = clampNumber(os.freemem())
  const used = Math.max(0, total - free)
  return {
    totalMemory: total,
    freeMemory: free,
    usedMemory: used,
    memoryUsagePercent: total > 0 ? (used / total) * 100 : 0,
    cpuCoreCount: Math.max(1, os.cpus().length),
    loadAverage1m: clampNumber(os.loadavg()[0])
  }
}

function emptySnapshot(): MemorySnapshot {
  const zero = { cpu: 0, memory: 0 }
  return {
    app: { ...zero, main: zero, renderer: zero, other: zero, processes: [], history: [] },
    worktrees: [],
    host: hostMetrics(),
    totalCpu: 0,
    totalMemory: 0,
    collectedAt: Date.now()
  }
}

// ─── History ring buffers ───────────────────────────────────────────

const APP_HISTORY_KEY = '__app__'
const HISTORY_CAPACITY = 60
const HISTORY_STALE_MS = 10 * 60 * 1000

type HistoryRing = {
  samples: number[]
  touchedAt: number
}

const historyByKey = new Map<string, HistoryRing>()

function pushHistorySample(key: string, memoryBytes: number, now: number): void {
  let ring = historyByKey.get(key)
  if (!ring) {
    ring = { samples: [], touchedAt: now }
    historyByKey.set(key, ring)
  }
  ring.samples.push(memoryBytes)
  if (ring.samples.length > HISTORY_CAPACITY) {
    ring.samples.shift()
  }
  ring.touchedAt = now
}

function readHistory(key: string): number[] {
  const ring = historyByKey.get(key)
  return ring ? [...ring.samples] : []
}

function sweepStaleHistory(now: number): void {
  for (const [key, ring] of historyByKey) {
    if (now - ring.touchedAt > HISTORY_STALE_MS) {
      historyByKey.delete(key)
    }
  }
}

// ─── Host process enumeration ───────────────────────────────────────

async function enumerateProcesses(): Promise<ProcIndex> {
  const rows = os.platform() === 'win32' ? await enumerateWindows() : await enumerateUnix()

  const byPid = new Map<number, ProcRow>()
  const childrenOf = new Map<number, number[]>()

  for (const row of rows) {
    byPid.set(row.pid, row)
    const siblings = childrenOf.get(row.ppid)
    if (siblings) {
      siblings.push(row.pid)
    } else {
      childrenOf.set(row.ppid, [row.pid])
    }
  }

  return { byPid, childrenOf }
}

async function enumerateUnix(): Promise<ProcRow[]> {
  // Why: `-o pcpu` formats the percentage with the current locale's decimal
  // separator (e.g. "12,5" on de_DE). parseFloat is locale-agnostic and
  // silently drops the fractional part at a comma. Forcing C locale keeps
  // decimals as dots.
  try {
    const { stdout } = await execAsync('ps -eo pid=,ppid=,pcpu=,rss=,command=', {
      maxBuffer: PS_MAX_BUFFER,
      timeout: PS_EXEC_TIMEOUT_MS,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
    })
    const rows = parsePsOutput(stdout)
    await hydrateUnixWideCommands(rows)
    return rows
  } catch (err) {
    console.warn('[memory] ps enumeration failed', err)
    return []
  }
}

/** Exported for tests: parses `ps -eo pid=,ppid=,pcpu=,rss=,command=` output. */
export function parsePsOutput(stdout: string): ProcRow[] {
  const rows: ProcRow[] = []
  const lines = stdout.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line.length === 0) {
      continue
    }
    const match = /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(.*))?$/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number.parseInt(match[1], 10)
    const ppid = Number.parseInt(match[2], 10)
    const cpu = Number.parseFloat(match[3])
    const rssKb = Number.parseInt(match[4], 10)
    const command = (match[5] ?? '').trim()
    if (Number.isNaN(pid) || Number.isNaN(ppid)) {
      continue
    }
    rows.push({
      pid,
      ppid,
      cpu: Number.isFinite(cpu) && cpu > 0 ? cpu : 0,
      memory: Number.isFinite(rssKb) && rssKb > 0 ? rssKb * 1024 : 0,
      command: command || null,
      name: command ? commandName(command) : null
    })
  }
  return rows
}

function shouldHydrateUnixWideCommand(row: ProcRow): boolean {
  const command = row.command ?? ''
  return command.includes('daemon-entry') && !command.includes('.token')
}

function parseWideCommandOutput(stdout: string): Map<number, string> {
  const commands = new Map<number, string>()
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (!line) {
      continue
    }
    const match = /^(\d+)\s+(.*)$/.exec(line)
    if (!match) {
      continue
    }
    const pid = Number.parseInt(match[1], 10)
    const command = match[2].trim()
    if (Number.isFinite(pid) && command) {
      commands.set(pid, command)
    }
  }
  return commands
}

async function hydrateUnixWideCommands(rows: ProcRow[]): Promise<void> {
  const candidatePids = rows.filter(shouldHydrateUnixWideCommand).map((row) => row.pid)
  if (candidatePids.length === 0) {
    return
  }

  // Why: daemon attribution needs socket/token args that may be truncated in
  // the cheap host-wide sweep. Hydrate only daemon rows whose token arg did
  // not survive, so most snapshots stay at one cheap `ps` process.
  const chunkSize = 50
  for (let start = 0; start < candidatePids.length; start += chunkSize) {
    const chunk = candidatePids.slice(start, start + chunkSize)
    try {
      const { stdout } = await execAsync(`ps -ww -p ${chunk.join(',')} -o pid=,command=`, {
        maxBuffer: PS_MAX_BUFFER,
        timeout: PS_EXEC_TIMEOUT_MS,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
      })
      const wideCommands = parseWideCommandOutput(stdout)
      for (const row of rows) {
        const command = wideCommands.get(row.pid)
        if (command) {
          row.command = command
          row.name = commandName(command)
        }
      }
    } catch {
      // Best effort only; the regular RSS/CPU attribution remains valid.
    }
  }
}

async function enumerateWindows(): Promise<ProcRow[]> {
  // Why: `wmic` ships with stock Windows and emits a plain, tab-separated
  // table without the CSV-quoting edge cases PowerShell's ConvertTo-Csv
  // introduces. CPU% would require delta sampling between two queries; for
  // v1 we report 0% on Windows — memory attribution is the primary signal.
  try {
    const { stdout } = await execAsync(
      'wmic process get ProcessId,ParentProcessId,WorkingSetSize,Name,CommandLine /format:value',
      { maxBuffer: PS_MAX_BUFFER, timeout: PS_EXEC_TIMEOUT_MS }
    )
    return parseWmicOutput(stdout)
  } catch (err) {
    console.warn('[memory] wmic enumeration failed', err)
    return []
  }
}

/** Exported for tests: parses `wmic /format:value` stanza output. */
export function parseWmicOutput(stdout: string): ProcRow[] {
  // wmic /format:value emits stanzas of `Key=Value` lines separated by blank
  // lines. We accumulate a record until a blank line, then flush.
  const rows: ProcRow[] = []
  let pid = Number.NaN
  let ppid = Number.NaN
  let ws = Number.NaN
  let command: string | null = null
  let name: string | null = null

  const flush = (): void => {
    if (!Number.isNaN(pid) && !Number.isNaN(ppid)) {
      rows.push({
        pid,
        ppid,
        cpu: 0,
        memory: Number.isFinite(ws) && ws > 0 ? ws : 0,
        command,
        name: name || (command ? commandName(command) : null)
      })
    }
    pid = Number.NaN
    ppid = Number.NaN
    ws = Number.NaN
    command = null
    name = null
  }

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.length === 0) {
      flush()
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) {
      continue
    }
    const key = line.slice(0, eq)
    const value = line.slice(eq + 1)
    if (key === 'ProcessId') {
      pid = Number.parseInt(value, 10)
    } else if (key === 'ParentProcessId') {
      ppid = Number.parseInt(value, 10)
    } else if (key === 'WorkingSetSize') {
      ws = Number.parseInt(value, 10)
    } else if (key === 'CommandLine') {
      command = value.trim() || null
    } else if (key === 'Name') {
      name = value.trim() || null
    }
  }
  flush()
  return rows
}

/** Walk every descendant PID of `root`, inclusive. Exported for tests. */
export function collectSubtree(index: ProcIndex, root: number): number[] {
  const result: number[] = []
  const seen = new Set<number>()
  const queue = [root]
  while (queue.length > 0) {
    const pid = queue.pop()
    if (pid === undefined) {
      break
    }
    if (seen.has(pid)) {
      continue
    }
    seen.add(pid)
    if (index.byPid.has(pid)) {
      result.push(pid)
    }
    const kids = index.childrenOf.get(pid)
    if (kids) {
      for (const kid of kids) {
        queue.push(kid)
      }
    }
  }
  return result
}

// ─── Electron app process bucketing ─────────────────────────────────

type AppBucketsRaw = Omit<AppMemory, 'history'>

function commandName(command: string): string {
  const firstToken = command.trim().split(/\s+/, 1)[0]?.trim() ?? ''
  const unquoted = firstToken.replace(/^["']|["']$/g, '')
  const parts = unquoted.split(/[\\/]+/)
  return parts.at(-1) || unquoted || command.trim()
}

function appMetricPrivateMemoryBytes(
  proc: ReturnType<typeof app.getAppMetrics>[number]
): number | null {
  const privateBytes = proc.memory?.privateBytes
  if (typeof privateBytes !== 'number' || !Number.isFinite(privateBytes) || privateBytes <= 0) {
    return null
  }
  return privateBytes * 1024
}

function electronMetricMemoryBytes(
  proc: ReturnType<typeof app.getAppMetrics>[number],
  processIndex: ProcIndex
): number {
  const hostMemory = processIndex.byPid.get(proc.pid)?.memory
  if (typeof hostMemory === 'number' && Number.isFinite(hostMemory) && hostMemory > 0) {
    return hostMemory
  }
  // Why: on macOS, app.getAppMetrics().workingSetSize can include large shared
  // Chromium/Electron mappings. Prefer the host RSS sweep used elsewhere, but
  // keep workingSetSize as a fallback when the process disappears mid-snapshot.
  return clampNumber(proc.memory?.workingSetSize) * 1024
}

function getCurrentDaemonPaths(): { socketPath: string; tokenPath: string } | null {
  try {
    const runtimeDir = join(app.getPath('userData'), 'daemon')
    return {
      socketPath: getDaemonSocketPath(runtimeDir),
      tokenPath: getDaemonTokenPath(runtimeDir)
    }
  } catch {
    return null
  }
}

function isCurrentDaemonProcess(
  row: ProcRow | undefined,
  daemonPaths: { socketPath: string; tokenPath: string } | null
): boolean {
  if (!row?.command || !daemonPaths) {
    return false
  }
  return (
    row.command.includes('daemon-entry') &&
    row.command.includes(daemonPaths.socketPath) &&
    row.command.includes(daemonPaths.tokenPath)
  )
}

function classifyAppProcess(
  proc: ReturnType<typeof app.getAppMetrics>[number],
  row: ProcRow | undefined,
  daemonPaths: { socketPath: string; tokenPath: string } | null
): { role: string; label: string } {
  if (isCurrentDaemonProcess(row, daemonPaths)) {
    return { role: 'Daemon', label: 'Terminal daemon' }
  }

  const type = (typeof proc.type === 'string' ? proc.type : '').toLowerCase()
  const name = typeof proc.name === 'string' ? proc.name.trim() : ''
  const command = row?.command ?? ''

  if (type === 'browser') {
    return { role: 'Main', label: 'Main process' }
  }
  if (type === 'renderer' || type === 'tab') {
    return { role: 'Renderer', label: name || 'Renderer process' }
  }
  if (type === 'gpu' || command.includes('--type=gpu-process')) {
    return { role: 'GPU', label: 'GPU process' }
  }
  if (name) {
    return { role: 'Utility', label: name }
  }
  if (type) {
    return { role: 'Other', label: `${type[0].toUpperCase()}${type.slice(1)} process` }
  }
  return { role: 'Other', label: 'Electron helper' }
}

function makeProcessDetail(args: {
  row: ProcRow | undefined
  pid: number
  cpu: number
  memory: number
  role: string
  label: string
  privateMemory?: number | null
}): ProcessMemoryDetail {
  return {
    pid: args.pid,
    ...(args.row ? { ppid: args.row.ppid } : {}),
    role: args.role,
    label: args.label,
    command: args.row?.command ?? null,
    cpu: clampNumber(args.cpu),
    memory: clampNumber(args.memory),
    privateMemory: args.privateMemory ?? null
  }
}

function daemonProcessDetail(row: ProcRow): ProcessMemoryDetail {
  return makeProcessDetail({
    row,
    pid: row.pid,
    cpu: row.cpu,
    memory: row.memory,
    role: 'Daemon',
    label: 'Terminal daemon'
  })
}

function bucketElectronMetrics(processIndex: ProcIndex): AppBucketsRaw {
  const main = { cpu: 0, memory: 0 }
  const renderer = { cpu: 0, memory: 0 }
  const other = { cpu: 0, memory: 0 }
  const processes: ProcessMemoryDetail[] = []
  const metricPids = new Set<number>()
  const daemonPaths = getCurrentDaemonPaths()

  for (const proc of app.getAppMetrics()) {
    const cpu = clampNumber(proc.cpu?.percentCPUUsage)
    const memoryBytes = electronMetricMemoryBytes(proc, processIndex)
    const row = processIndex.byPid.get(proc.pid)
    const classified = classifyAppProcess(proc, row, daemonPaths)
    metricPids.add(proc.pid)

    // Why: lowercase once so future Electron versions emitting different
    // casing ('browser' vs 'Browser') still bucket correctly.
    const type = (typeof proc.type === 'string' ? proc.type : '').toLowerCase()
    let target = other
    if (type === 'browser') {
      target = main
    } else if (type === 'renderer' || type === 'tab') {
      target = renderer
    }

    target.cpu += cpu
    target.memory += memoryBytes
    processes.push(
      makeProcessDetail({
        row,
        pid: proc.pid,
        cpu,
        memory: memoryBytes,
        role: classified.role,
        label: classified.label,
        privateMemory: appMetricPrivateMemoryBytes(proc)
      })
    )
  }

  for (const row of processIndex.byPid.values()) {
    if (metricPids.has(row.pid) || !isCurrentDaemonProcess(row, daemonPaths)) {
      continue
    }
    other.cpu += row.cpu
    other.memory += row.memory
    processes.push(daemonProcessDetail(row))
  }

  processes.sort((a, b) => b.memory - a.memory)

  return {
    main,
    renderer,
    other,
    cpu: main.cpu + renderer.cpu + other.cpu,
    memory: main.memory + renderer.memory + other.memory,
    processes
  }
}

// ─── Worktree attribution ───────────────────────────────────────────

type WorktreeBucket = {
  worktreeId: string
  worktreeName: string
  repoId: string
  repoName: string
  cpu: number
  memory: number
  sessions: SessionMemory[]
}

function resolveWorktreeNames(
  worktreeId: string,
  store: MemorySnapshotStore
): {
  worktreeName: string
  repoId: string
  repoName: string
} {
  // Orca worktree ids look like `${repoId}::${absolutePath}`.
  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  const repoId = parsed?.repoId ?? worktreeId
  const worktreePath = parsed?.worktreePath ?? ''
  const fallbackName = worktreePath ? basename(worktreePath) : worktreeId

  const meta = store.getWorktreeMeta(worktreeId)
  const repo = store.getRepo(repoId)

  return {
    worktreeName: meta?.displayName?.trim() || fallbackName,
    repoId,
    repoName: repo?.displayName?.trim() || repoId || 'Unknown Repo'
  }
}

function makeEmptyBucket(
  worktreeId: string,
  worktreeName: string,
  repoId: string,
  repoName: string
): WorktreeBucket {
  return { worktreeId, worktreeName, repoId, repoName, cpu: 0, memory: 0, sessions: [] }
}

function classifyTerminalProcess(row: ProcRow): { role: string; label: string } {
  const command = row.command ?? ''
  const executable = (row.name || (command ? commandName(command) : '')).toLowerCase()

  if (
    executable === 'codex' ||
    executable === 'claude' ||
    executable === 'opencode' ||
    executable === 'gemini' ||
    executable === 'aider' ||
    executable === 'cursor-agent'
  ) {
    return { role: 'Agent CLI', label: row.name ?? commandName(command) }
  }
  if (
    executable === 'bash' ||
    executable === 'zsh' ||
    executable === 'fish' ||
    executable === 'sh' ||
    executable === 'pwsh' ||
    executable === 'powershell.exe' ||
    executable === 'cmd.exe'
  ) {
    return { role: 'Shell', label: row.name ?? commandName(command) }
  }
  if (
    executable === 'node' ||
    executable === 'npm' ||
    executable === 'pnpm' ||
    executable === 'yarn' ||
    executable === 'bun' ||
    executable === 'deno' ||
    executable === 'vite' ||
    executable === 'tsserver' ||
    executable === 'esbuild'
  ) {
    return { role: 'Node/dev', label: row.name ?? commandName(command) }
  }
  if (executable === 'git') {
    return { role: 'Git', label: 'git' }
  }
  return {
    role: 'Subprocess',
    label: row.name ?? (command ? commandName(command) : `pid ${row.pid}`)
  }
}

function terminalProcessDetail(row: ProcRow): ProcessMemoryDetail {
  const classified = classifyTerminalProcess(row)
  return makeProcessDetail({
    row,
    pid: row.pid,
    cpu: row.cpu,
    memory: row.memory,
    role: classified.role,
    label: classified.label
  })
}

// ─── Main collection path ───────────────────────────────────────────

async function runSnapshot(store: MemorySnapshotStore): Promise<MemorySnapshot> {
  const processIndex = await enumerateProcesses()
  const appBuckets = bucketElectronMetrics(processIndex)
  const ptys = listRegisteredPtys()

  // Why: when two PTYs share an ancestor in the process tree (e.g. a
  // supervisor, or a shell that re-execed), a naive walk would double-count
  // that ancestor's memory. Track which pids have already been claimed and
  // attribute to the first PTY (registration order) to see each pid.
  const claimed = new Set<number>()

  const orphan = makeEmptyBucket(
    ORPHAN_WORKTREE_ID,
    'Unattributed terminals',
    ORPHAN_WORKTREE_ID,
    'Other'
  )
  const worktreeBuckets = new Map<string, WorktreeBucket>()

  for (const pty of ptys) {
    let sessionCpu = 0
    let sessionMemory = 0
    const sessionProcesses: ProcessMemoryDetail[] = []

    if (pty.pid != null) {
      for (const pid of collectSubtree(processIndex, pty.pid)) {
        if (claimed.has(pid)) {
          continue
        }
        const row = processIndex.byPid.get(pid)
        if (!row) {
          continue
        }
        claimed.add(pid)
        sessionCpu += row.cpu
        sessionMemory += row.memory
        sessionProcesses.push(terminalProcessDetail(row))
      }
    }
    sessionProcesses.sort((a, b) => b.memory - a.memory)

    const session: SessionMemory = {
      sessionId: pty.sessionId ?? pty.ptyId,
      paneKey: pty.paneKey,
      pid: pty.pid ?? 0,
      cpu: clampNumber(sessionCpu),
      memory: clampNumber(sessionMemory),
      processes: sessionProcesses
    }

    let bucket: WorktreeBucket
    if (pty.worktreeId) {
      const existing = worktreeBuckets.get(pty.worktreeId)
      if (existing) {
        bucket = existing
      } else {
        const names = resolveWorktreeNames(pty.worktreeId, store)
        bucket = makeEmptyBucket(pty.worktreeId, names.worktreeName, names.repoId, names.repoName)
        worktreeBuckets.set(pty.worktreeId, bucket)
      }
    } else {
      bucket = orphan
    }

    bucket.cpu += session.cpu
    bucket.memory += session.memory
    bucket.sessions.push(session)
  }

  const bucketList: WorktreeBucket[] = [...worktreeBuckets.values()]
  if (orphan.sessions.length > 0) {
    bucketList.push(orphan)
  }

  // Why: record this sweep's samples *before* reading back history, so the
  // returned arrays end with the freshly-collected value. Each write also
  // acts as a keep-alive so active worktrees survive the staleness sweep.
  const now = Date.now()
  pushHistorySample(APP_HISTORY_KEY, appBuckets.memory, now)
  for (const bucket of bucketList) {
    pushHistorySample(bucket.worktreeId, bucket.memory, now)
  }
  sweepStaleHistory(now)

  const worktrees: WorktreeMemory[] = bucketList.map((b) => ({
    ...b,
    history: readHistory(b.worktreeId)
  }))

  let sessionCpuTotal = 0
  let sessionMemoryTotal = 0
  for (const wt of worktrees) {
    sessionCpuTotal += wt.cpu
    sessionMemoryTotal += wt.memory
  }

  return {
    app: { ...appBuckets, history: readHistory(APP_HISTORY_KEY) },
    worktrees,
    host: hostMetrics(),
    totalCpu: appBuckets.cpu + sessionCpuTotal,
    totalMemory: appBuckets.memory + sessionMemoryTotal,
    collectedAt: now
  }
}
