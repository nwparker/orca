import type { SubprocessHandle } from './session-subprocess-handle'
import { isValidPtySize } from './daemon-pty-size'
import { signalPosixPtyForegroundGroup } from '../pty/posix-pty-foreground-group'
import { readPtsName } from '../pty/node-pty-pts-name'
import { forceKillPosixPtyProcessGroups } from '../pty/posix-pty-process-groups'
import { readPtySlavePath } from '../../shared/pty-slave-line-discipline-echo'
import { terminatePtyJob } from '../windows/windows-pty-job'
import { createDaemonPtyEventBuffer } from './daemon-pty-event-buffer'
import { createDaemonPtyForegroundTracker } from './daemon-pty-foreground-tracker'
import type { DaemonPtyLaunchOptions, DaemonPtyLaunchPlan } from './daemon-pty-launch-plan'
import type { SpawnedDaemonPty } from './daemon-pty-native-spawn'

export function createDaemonPtySubprocessHandle(args: {
  spawned: SpawnedDaemonPty
  plan: DaemonPtyLaunchPlan
  opts: DaemonPtyLaunchOptions
}): SubprocessHandle {
  const { spawned, plan, opts } = args
  const proc = spawned.process
  let dead = false
  let disposed = false
  let nodePtyKillIssued = false
  const foreground = createDaemonPtyForegroundTracker({
    proc,
    shellPath: spawned.shellPath,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    startupAgentRecognition: plan.startupAgentRecognition
  })
  // Register event forwarding before the dead-state listener to preserve callback ordering.
  const events = createDaemonPtyEventBuffer({
    proc,
    reportsChildExitStatus: spawned.reportsChildExitStatus,
    noteOutput: (data) => foreground.noteOutput(data)
  })
  proc.onExit(() => {
    dead = true
    foreground.markExited()
    // Why: UnixTerminal can asynchronously signal a recycled pid after exit.
    if (process.platform !== 'win32') {
      ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
    }
  })

  const startupCommandDeliveredInShellArgs =
    spawned.startupCommandDeliveredInShellArgs ?? plan.startupCommandDeliveredInShellArgs
  const slavePath = readPtySlavePath(proc)
  return {
    pid: proc.pid,
    shellPath: spawned.shellPath,
    shellCwd: spawned.spawnCwd,
    shellPathEnv: plan.env.PATH,
    ...(slavePath ? { slavePath } : {}),
    ...(startupCommandDeliveredInShellArgs ? { startupCommandDeliveredInShellArgs: true } : {}),
    getForegroundProcess: () => (dead ? null : foreground.getForegroundProcess()),
    confirmForegroundProcess: () =>
      dead ? Promise.resolve(null) : foreground.confirmForegroundProcess(),
    write(data) {
      if (dead) {
        return
      }
      try {
        proc.write(data)
      } catch {
        dead = true
        foreground.markExited()
      }
    },
    resize(cols, rows) {
      if (dead || !isValidPtySize(cols, rows)) {
        return
      }
      try {
        proc.resize(cols, rows)
      } catch {
        dead = true
        foreground.markExited()
      }
    },
    pause() {
      if (dead) {
        return
      }
      try {
        proc.pause()
      } catch {
        // Native flow control is best-effort.
      }
    },
    resume() {
      if (dead) {
        return
      }
      try {
        proc.resume()
      } catch {
        // Native flow control is best-effort.
      }
    },
    clear() {
      if (dead) {
        return
      }
      try {
        proc.clear()
      } catch {
        // A clear racing exit must not kill the handle.
      }
    },
    kill() {
      if (dead) {
        return
      }
      nodePtyKillIssued = true
      try {
        proc.kill()
      } catch (error) {
        nodePtyKillIssued = false
        throw error
      }
    },
    terminateOwnedTree: () => terminatePtyJob(proc),
    forceKill() {
      if (dead) {
        return
      }
      if (process.platform === 'win32' && nodePtyKillIssued) {
        terminatePtyJob(proc)
        return
      }
      try {
        forceKillPosixPtyProcessGroups(proc.pid, () => {
          process.kill(proc.pid, 'SIGKILL')
        })
      } catch (signalError) {
        try {
          proc.kill()
          nodePtyKillIssued = true
        } catch {
          nodePtyKillIssued = false
          throw signalError
        }
      }
    },
    signal(sig) {
      if (dead) {
        return
      }
      const signalRootPid = (): void => {
        try {
          process.kill(proc.pid, sig)
        } catch {
          // Process may already be dead.
        }
      }
      if (sig === 'SIGWINCH') {
        signalPosixPtyForegroundGroup(proc.pid, readPtsName(proc), sig, signalRootPid)
      } else {
        signalRootPid()
      }
    },
    onData: (cb) => events.onData(cb),
    onExit: (cb) => events.onExit(cb),
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      dead = true
      foreground.markExited()
      events.dispose()
      if (process.platform !== 'win32') {
        ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
      } else if (nodePtyKillIssued) {
        return
      }
      try {
        ;(proc as unknown as { destroy?: () => void }).destroy?.()
      } catch {
        // Native handle already torn down.
      }
    }
  }
}
