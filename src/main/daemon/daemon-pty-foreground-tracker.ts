import type * as pty from 'node-pty'
import { win32 as pathWin32 } from 'node:path'
import { resolveAgentForegroundProcessWithAvailability } from '../providers/agent-foreground-process'
import { readWindowsConptyProcessIds } from '../providers/windows-conpty-process-membership'
import {
  isAgentForegroundWrapperProcess,
  recognizeAgentProcess,
  type recognizeAgentProcessFromCommandLine
} from '../../shared/agent-process-recognition'
import { shouldInspectOuterWrapperForegroundProcess } from '../../shared/foreground-wrapper-agent'
import { isShellProcess } from '../../shared/shell-process-detection'
import { getAgentForegroundContextPaths } from '../providers/agent-foreground-context-paths'
import { parsePtySessionId } from './pty-session-id'

const FOREGROUND_AGENT_CACHE_TTL_MS = 1_000
const SHELL_FOREGROUND_REFRESH_RETRY_MS = 5_000
const WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS = 15_000
const SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS = 10_000
const STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS = 5_000

type StartupAgentRecognition = ReturnType<typeof recognizeAgentProcessFromCommandLine>

export type DaemonPtyForegroundTracker = {
  noteOutput(data: string): void
  markExited(): void
  getForegroundProcess(): string | null
  confirmForegroundProcess(): Promise<string | null>
}

function normalizeForegroundProcessName(processName: string | null | undefined): string | null {
  const trimmed = processName?.trim().replace(/^["']|["']$/g, '') ?? ''
  if (!trimmed || trimmed === 'xterm-256color') {
    return null
  }
  return trimmed.split(/[\\/]/).pop() || null
}

function resolveFallbackForegroundProcess(
  processName: string | null | undefined,
  shellPath: string
): string | null {
  const normalized = normalizeForegroundProcessName(processName)
  if (normalized || process.platform !== 'win32') {
    return normalized
  }
  return normalizeForegroundProcessName(pathWin32.basename(shellPath))
}

function shouldInspectOuterWrapperFallback(processName: string | null): boolean {
  const recognized = recognizeAgentProcess(processName)
  return recognized !== null && shouldInspectOuterWrapperForegroundProcess(recognized)
}

export function createDaemonPtyForegroundTracker(args: {
  proc: pty.IPty
  shellPath: string
  sessionId: string
  cwd?: string
  startupAgentRecognition: StartupAgentRecognition
}): DaemonPtyForegroundTracker {
  const { proc } = args
  let dead = false
  let lastOutputAt = 0
  let cachedAgentForeground: { processName: string; refreshedAt: number } | null = null
  const agentForegroundContextPaths = getAgentForegroundContextPaths({
    cwd: args.cwd,
    worktreeId: parsePtySessionId(args.sessionId).worktreeId
  })
  let startupAgentForeground: { processName: string; expiresAt: number } | null =
    args.startupAgentRecognition
      ? {
          processName: args.startupAgentRecognition.processName,
          expiresAt: Date.now() + STARTUP_AGENT_FOREGROUND_BOOTSTRAP_MS
        }
      : null
  let foregroundRefreshInFlight = false
  let lastForegroundRefreshStartedAt = 0

  const getFallbackForegroundProcess = (): string | null =>
    resolveFallbackForegroundProcess(proc.process, args.shellPath)
  const getActiveStartupAgentForeground = (
    now = Date.now()
  ): { processName: string; expiresAt: number } | null => {
    if (!startupAgentForeground) {
      return null
    }
    if (now > startupAgentForeground.expiresAt) {
      startupAgentForeground = null
      return null
    }
    return startupAgentForeground
  }
  const shouldInspectFallbackForegroundProcess = (fallbackProcess: string | null): boolean =>
    fallbackProcess !== null &&
    (isShellProcess(fallbackProcess) ||
      isAgentForegroundWrapperProcess(fallbackProcess) ||
      shouldInspectOuterWrapperFallback(fallbackProcess) ||
      process.platform !== 'win32')

  const scheduleAgentForegroundRefresh = (fallbackProcess: string | null): void => {
    if (dead || !proc.pid) {
      return
    }
    const fallbackIsShell = fallbackProcess !== null && isShellProcess(fallbackProcess)
    const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
    if (
      !fallbackProcess ||
      (fallbackRecognition !== null &&
        !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
      !shouldInspectFallbackForegroundProcess(fallbackProcess)
    ) {
      return
    }
    const now = Date.now()
    const idleNoEvidenceShell =
      fallbackIsShell && !getActiveStartupAgentForeground(now) && !cachedAgentForeground
    const retryMs = !idleNoEvidenceShell
      ? FOREGROUND_AGENT_CACHE_TTL_MS
      : process.platform === 'win32' && now - lastOutputAt > SHELL_FOREGROUND_OUTPUT_HOT_WINDOW_MS
        ? WINDOWS_IDLE_SHELL_FOREGROUND_REFRESH_RETRY_MS
        : SHELL_FOREGROUND_REFRESH_RETRY_MS
    if (foregroundRefreshInFlight || now - lastForegroundRefreshStartedAt < retryMs) {
      return
    }
    foregroundRefreshInFlight = true
    lastForegroundRefreshStartedAt = now
    const retireStaleForegroundIdentity = (): void => {
      const currentFallbackProcess = getFallbackForegroundProcess()
      if (
        fallbackIsShell &&
        !getActiveStartupAgentForeground() &&
        currentFallbackProcess !== null &&
        isShellProcess(currentFallbackProcess)
      ) {
        cachedAgentForeground = null
        startupAgentForeground = null
      } else if (
        cachedAgentForeground !== null &&
        Date.now() - cachedAgentForeground.refreshedAt > FOREGROUND_AGENT_CACHE_TTL_MS &&
        currentFallbackProcess !== null &&
        isAgentForegroundWrapperProcess(currentFallbackProcess)
      ) {
        cachedAgentForeground = null
      }
    }
    void resolveAgentForegroundProcessWithAvailability(proc.pid, fallbackProcess, {
      contextPaths: agentForegroundContextPaths
    })
      .then<string | void>(({ processName, available }) => {
        if (dead || !available) {
          return
        }
        if (!processName || !recognizeAgentProcess(processName)) {
          if (process.platform === 'win32' && fallbackIsShell && cachedAgentForeground !== null) {
            return readWindowsConptyProcessIds(proc.pid).then((consoleProcessIds) => {
              if (dead || consoleProcessIds === null || consoleProcessIds.size > 1) {
                return
              }
              retireStaleForegroundIdentity()
            })
          }
          retireStaleForegroundIdentity()
          return
        }
        cachedAgentForeground = { processName, refreshedAt: Date.now() }
        startupAgentForeground = null
        return processName
      })
      .catch(() => {
        // Foreground enrichment must never affect PTY health.
      })
      .finally(() => {
        foregroundRefreshInFlight = false
      })
  }

  return {
    noteOutput(data) {
      if (data.length > 0) {
        lastOutputAt = Date.now()
      }
    },
    markExited() {
      dead = true
      cachedAgentForeground = null
      startupAgentForeground = null
    },
    getForegroundProcess() {
      if (dead) {
        return null
      }
      try {
        const fallbackProcess = getFallbackForegroundProcess()
        const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
        const inspectOuterWrapper =
          fallbackRecognition !== null &&
          shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)
        if (fallbackProcess && fallbackRecognition && !inspectOuterWrapper) {
          cachedAgentForeground = { processName: fallbackProcess, refreshedAt: Date.now() }
          startupAgentForeground = null
          return fallbackProcess
        }
        scheduleAgentForegroundRefresh(fallbackProcess)
        const now = Date.now()
        if (
          cachedAgentForeground &&
          now - cachedAgentForeground.refreshedAt <= FOREGROUND_AGENT_CACHE_TTL_MS
        ) {
          return cachedAgentForeground.processName
        }
        if (
          cachedAgentForeground &&
          fallbackProcess !== null &&
          (isAgentForegroundWrapperProcess(fallbackProcess) ||
            inspectOuterWrapper ||
            (process.platform === 'win32' && isShellProcess(fallbackProcess)))
        ) {
          return cachedAgentForeground.processName
        }
        const activeStartupAgentForeground = getActiveStartupAgentForeground(now)
        if (fallbackProcess && isShellProcess(fallbackProcess) && activeStartupAgentForeground) {
          return activeStartupAgentForeground.processName
        }
        return fallbackProcess
      } catch {
        return null
      }
    },
    async confirmForegroundProcess() {
      if (dead || !proc.pid) {
        return null
      }
      try {
        const fallbackProcess = getFallbackForegroundProcess()
        const fallbackRecognition = recognizeAgentProcess(fallbackProcess)
        if (
          !fallbackProcess ||
          (fallbackRecognition !== null &&
            process.platform !== 'win32' &&
            !shouldInspectOuterWrapperForegroundProcess(fallbackRecognition)) ||
          (process.platform !== 'win32' && !shouldInspectFallbackForegroundProcess(fallbackProcess))
        ) {
          return fallbackProcess
        }
        const resolution = await resolveAgentForegroundProcessWithAvailability(
          proc.pid,
          fallbackProcess,
          {
            contextPaths: agentForegroundContextPaths,
            fresh: true,
            ...(process.platform === 'win32'
              ? {
                  forceProcessScan: true,
                  readWindowsConptyProcessIds: () => readWindowsConptyProcessIds(proc.pid)
                }
              : {})
          }
        )
        if (dead || !resolution.available) {
          return null
        }
        const recognized = recognizeAgentProcess(resolution.processName)
        if (recognized) {
          cachedAgentForeground = {
            processName: recognized.processName,
            refreshedAt: Date.now()
          }
          startupAgentForeground = null
          return recognized.processName
        }
        cachedAgentForeground = null
        startupAgentForeground = null
        return resolution.processName
      } catch {
        return null
      }
    }
  }
}
