import type { SubprocessHandle } from './session-subprocess-handle'
import { normalizePtySize } from './daemon-pty-size'
import { createDaemonPtyLaunchPlan, type DaemonPtyLaunchOptions } from './daemon-pty-launch-plan'
import { preflightDaemonPtySpawn } from './daemon-pty-spawn-preflight'
import { spawnDaemonPty } from './daemon-pty-native-spawn'
import { createDaemonPtySubprocessHandle } from './daemon-pty-subprocess-handle'
import { checkDaemonPtySpawnHealth } from './daemon-pty-spawn-health'

export type PtySubprocessOptions = DaemonPtyLaunchOptions

export async function checkPtySpawnHealth(): Promise<void> {
  await checkDaemonPtySpawnHealth()
}

export async function createPtySubprocess(opts: PtySubprocessOptions): Promise<SubprocessHandle> {
  const size = normalizePtySize(opts.cols, opts.rows)
  const plan = createDaemonPtyLaunchPlan(opts)
  await preflightDaemonPtySpawn(plan, opts)
  const spawned = spawnDaemonPty({
    plan,
    cols: size.cols,
    rows: size.rows,
    onMacosTccSpawnStrategy: opts.onMacosTccSpawnStrategy
  })
  return createDaemonPtySubprocessHandle({ spawned, plan, opts })
}
