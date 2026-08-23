import * as pty from 'node-pty'
import {
  hostReportsChildExitStatus,
  wrapShellSpawnForMacosTccAttribution
} from '../providers/macos-tcc-login-shell'
import { assignHostProcessToKillOnCloseJob } from '../windows/windows-pty-job'
import type { DaemonPtyLaunchOptions, DaemonPtyLaunchPlan } from './daemon-pty-launch-plan'
import { formatDaemonPtySpawnError } from './daemon-pty-spawn-preflight'

export type SpawnedDaemonPty = {
  process: pty.IPty
  shellPath: string
  spawnCwd: string
  startupCommandDeliveredInShellArgs?: boolean
  reportsChildExitStatus: boolean
}

function spawnAt(args: {
  shellPath: string
  shellArgs: string[]
  cwd: string
  env: Record<string, string>
  cols: number
  rows: number
  onMacosTccSpawnStrategy?: DaemonPtyLaunchOptions['onMacosTccSpawnStrategy']
}): { process: pty.IPty; reportsChildExitStatus: boolean } {
  const wrapped = wrapShellSpawnForMacosTccAttribution(args.shellPath, args.shellArgs, args.env)
  // Why: children must inherit the daemon job before the first ConPTY starts.
  if (process.platform === 'win32') {
    assignHostProcessToKillOnCloseJob()
  }
  const spawned = pty.spawn(wrapped.file, wrapped.args, {
    name: args.env.TERM ?? 'xterm-256color',
    cols: args.cols,
    rows: args.rows,
    cwd: args.cwd,
    env: args.env,
    ...(process.platform === 'win32' ? { useConptyDll: true } : {})
  })
  const reportsChildExitStatus = hostReportsChildExitStatus(wrapped.file)
  args.onMacosTccSpawnStrategy?.(wrapped.file === args.shellPath ? 'direct' : 'wrapped')
  return {
    process: spawned,
    reportsChildExitStatus
  }
}

export function spawnDaemonPty(args: {
  plan: DaemonPtyLaunchPlan
  cols: number
  rows: number
  onMacosTccSpawnStrategy?: DaemonPtyLaunchOptions['onMacosTccSpawnStrategy']
}): SpawnedDaemonPty {
  const { plan } = args
  try {
    const spawned = spawnAt({
      shellPath: plan.shellPath,
      shellArgs: plan.shellArgs,
      cwd: plan.spawnCwd,
      env: plan.env,
      cols: args.cols,
      rows: args.rows,
      onMacosTccSpawnStrategy: args.onMacosTccSpawnStrategy
    })
    return {
      ...spawned,
      shellPath: plan.shellPath,
      spawnCwd: plan.spawnCwd
    }
  } catch (primaryErr) {
    if (process.platform !== 'win32') {
      throw primaryErr
    }
    for (const attempt of plan.windowsFallbackAttempts.slice(1)) {
      try {
        const spawned = spawnAt({
          shellPath: attempt.shellPath,
          shellArgs: attempt.shellArgs,
          cwd: attempt.effectiveCwd,
          env: plan.env,
          cols: args.cols,
          rows: args.rows,
          onMacosTccSpawnStrategy: args.onMacosTccSpawnStrategy
        })
        const message = primaryErr instanceof Error ? primaryErr.message : String(primaryErr)
        console.warn(
          `[daemon/pty] Primary shell "${plan.shellPath}" failed (${message}), fell back to "${attempt.shellPath}"`
        )
        return {
          ...spawned,
          shellPath: attempt.shellPath,
          spawnCwd: attempt.effectiveCwd,
          startupCommandDeliveredInShellArgs: attempt.startupCommandDeliveredInShellArgs
        }
      } catch {
        // Try the next fallback.
      }
    }
    throw formatDaemonPtySpawnError(primaryErr, plan.shellPath, plan.spawnCwd)
  }
}
