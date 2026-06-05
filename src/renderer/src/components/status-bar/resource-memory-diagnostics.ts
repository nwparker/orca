import type { MemorySnapshot, ProcessMemoryDetail } from '../../../../shared/types'
import type { UnifiedProjectGroup, UnifiedSessionRow } from './mergeSnapshotAndSessions'

export type ResourceMemorySessionBreakdown = {
  session: UnifiedSessionRow
  repoName: string
  worktreeName: string
}

export function formatResourceMemory(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

export function formatResourceCpu(percent: number): string {
  return `${percent.toFixed(1)}%`
}

export function getTopProcesses(
  processes: readonly ProcessMemoryDetail[] | undefined,
  limit: number
): ProcessMemoryDetail[] {
  return [...(processes ?? [])].sort((a, b) => b.memory - a.memory).slice(0, limit)
}

export function collectLocalSessionBreakdowns(
  repos: readonly UnifiedProjectGroup[]
): ResourceMemorySessionBreakdown[] {
  const sessions: ResourceMemorySessionBreakdown[] = []
  for (const repo of repos) {
    for (const worktree of repo.worktrees) {
      for (const session of worktree.sessions) {
        if (session.hasLocalSamples && session.processes.length > 0) {
          sessions.push({
            session,
            repoName: repo.repoName,
            worktreeName: worktree.worktreeName
          })
        }
      }
    }
  }
  sessions.sort((a, b) => (b.session.memory ?? 0) - (a.session.memory ?? 0))
  return sessions
}

export function countRemoteUnsampledSessions(repos: readonly UnifiedProjectGroup[]): number {
  let count = 0
  for (const repo of repos) {
    for (const worktree of repo.worktrees) {
      for (const session of worktree.sessions) {
        if (!session.hasLocalSamples) {
          count += 1
        }
      }
    }
  }
  return count
}

function truncateLine(value: string | null, maxLength: number): string {
  if (!value) {
    return ''
  }
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value
}

function formatProcessDiagnosticLine(process: ProcessMemoryDetail): string {
  const privatePart =
    typeof process.privateMemory === 'number' && process.privateMemory > 0
      ? `, private ${formatResourceMemory(process.privateMemory)}`
      : ''
  const command = truncateLine(process.command, 140)
  return [
    `- ${process.role}: ${process.label} (pid ${process.pid})`,
    `${formatResourceMemory(process.memory)} RSS${privatePart}`,
    `${formatResourceCpu(process.cpu)} CPU`,
    command ? `cmd: ${command}` : ''
  ]
    .filter(Boolean)
    .join(' | ')
}

export function buildResourceMemoryDiagnostics(args: {
  snapshot: MemorySnapshot
  repos: readonly UnifiedProjectGroup[]
  platformLabel: string
  generatedAt?: Date
}): string {
  const generatedAt = args.generatedAt ?? new Date(args.snapshot.collectedAt)
  const hostTotal = args.snapshot.host.totalMemory
  const hostShare = hostTotal > 0 ? (args.snapshot.totalMemory / hostTotal) * 100 : 0
  const lines = [
    '[Orca Resource Manager]',
    `Generated: ${generatedAt.toISOString()}`,
    `Platform: ${args.platformLabel}`,
    `Tracked memory: ${formatResourceMemory(args.snapshot.totalMemory)} RSS`,
    `Tracked CPU: ${formatResourceCpu(args.snapshot.totalCpu)}`,
    `System share: ${hostShare.toFixed(0)}% of ${formatResourceMemory(hostTotal)}`,
    ''
  ]

  lines.push('Orca app processes:')
  const appProcesses = getTopProcesses(args.snapshot.app.processes, 8)
  if (appProcesses.length === 0) {
    lines.push('- No app process details sampled')
  } else {
    for (const process of appProcesses) {
      lines.push(formatProcessDiagnosticLine(process))
    }
  }

  lines.push('', 'Terminal sessions:')
  const localSessions = collectLocalSessionBreakdowns(args.repos).slice(0, 8)
  if (localSessions.length === 0) {
    lines.push('- No local terminal process details sampled')
  } else {
    for (const item of localSessions) {
      lines.push(
        `- ${item.repoName} / ${item.worktreeName} / ${item.session.label}: ${formatResourceMemory(
          item.session.memory ?? 0
        )} RSS`
      )
      for (const process of getTopProcesses(item.session.processes, 5)) {
        lines.push(`  ${formatProcessDiagnosticLine(process)}`)
      }
    }
  }

  const remoteCount = countRemoteUnsampledSessions(args.repos)
  if (remoteCount > 0) {
    lines.push('', `Remote sessions not sampled locally: ${remoteCount}`)
  }

  return lines.join('\n')
}
