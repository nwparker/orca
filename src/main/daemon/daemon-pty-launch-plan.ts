import { win32 as pathWin32 } from 'node:path'
import { getShellLaunchConfig, resolvePtyShellPath } from './shell-ready'
import { selectShellStartupFeatures } from '../shell-startup-features'
import { resolveUnixShellPath } from '../providers/local-pty-utils'
import {
  ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE_ENV,
  resolveWindowsShellLaunchArgs
} from '../providers/windows-shell-args'
import {
  resolveEffectiveWindowsPowerShell,
  shouldProbeWindowsPowerShellAvailability,
  type WindowsPowerShellShellFamily
} from '../providers/windows-powershell'
import {
  buildWindowsPowerShellSpawnAttempts,
  type WindowsShellSpawnAttempt
} from '../providers/windows-shell-fallback-chain'
import { isPwshAvailable } from '../pwsh'
import { isHostCodexHomeForWsl, isWslCodexHomeForHost } from '../pty/codex-home-wsl-env'
import { parseWslPath } from '../wsl'
import { addWslEnvKeys } from '../wsl-env'
import { resolveWslSessionContext } from './wsl-session-context'
import { addOrcaWslInteropEnv } from '../pty/wsl-orca-env'
import { isWindowsGitBashShellPath, resolveWindowsGitBashShellPath } from '../git-bash'
import { WINDOWS_GIT_BASH_SHELL } from '../../shared/windows-terminal-shell'
import {
  shouldUseShellReadyStartupDelivery,
  type StartupCommandDelivery
} from '../../shared/codex-startup-delivery'
import { assertSafeAgentStartupCwd } from '../providers/pty-default-cwd'
import { ORCA_HERMES_STARTUP_QUERY_ENV } from '../../shared/hermes-startup-query'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  createDaemonPtyEnvironment,
  deleteRequestedDaemonEnvKeys,
  finalizeDaemonPtyEnvironment
} from './daemon-pty-environment'
import { resolveDaemonPtyDefaultCwd } from './daemon-pty-spawn-preflight'

export type DaemonPtyLaunchOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  command?: string
  startupCommandDelivery?: StartupCommandDelivery
  launchAgent?: TuiAgent
  shellOverride?: string
  terminalWindowsWslDistro?: string | null
  terminalWindowsPowerShellImplementation?: 'auto' | 'powershell.exe' | 'pwsh.exe'
  isCanceled?: () => boolean
  cancelSignal?: AbortSignal
  onMacosTccSpawnStrategy?: (strategy: 'wrapped' | 'direct') => void
}

export type DaemonPtyLaunchPlan = {
  env: Record<string, string>
  shellPath: string
  shellArgs: string[]
  spawnCwd: string
  validationCwd: string
  windowsFallbackAttempts: WindowsShellSpawnAttempt[]
  startupCommandDeliveredInShellArgs: boolean
  startupAgentRecognition: ReturnType<typeof recognizeAgentProcessFromCommandLine>
}

function resolveWindowsLaunchPlan(args: {
  opts: DaemonPtyLaunchOptions
  env: Record<string, string>
  shellPath: string
  requestedCwd: string
  resolvedWslContext: ReturnType<typeof resolveWslSessionContext>
}): Omit<DaemonPtyLaunchPlan, 'env' | 'startupAgentRecognition'> {
  const { opts, env, requestedCwd, resolvedWslContext } = args
  let { shellPath } = args
  let shellArgs: string[]
  let spawnCwd = requestedCwd
  let validationCwd = spawnCwd
  let startupCommandDeliveredInShellArgs = false
  const normalizedShellFamily = pathWin32.basename(shellPath).toLowerCase()
  const resolvedGitBashPath = resolveWindowsGitBashShellPath(shellPath)
  const resolvedShellFamily: WindowsPowerShellShellFamily =
    normalizedShellFamily === 'powershell.exe' || normalizedShellFamily === 'pwsh.exe'
      ? normalizedShellFamily
      : normalizedShellFamily === 'cmd.exe' || normalizedShellFamily === 'wsl.exe'
        ? normalizedShellFamily
        : undefined
  const shouldProbePwsh = shouldProbeWindowsPowerShellAvailability({
    shellFamily: resolvedShellFamily,
    implementation: opts.terminalWindowsPowerShellImplementation
  })
  const shouldResolvePowerShellFamily =
    opts.terminalWindowsPowerShellImplementation !== undefined ||
    pathWin32.basename(shellPath) === shellPath
  if (resolvedGitBashPath) {
    shellPath = resolvedGitBashPath
  } else if (shellPath === WINDOWS_GIT_BASH_SHELL) {
    shellPath = 'powershell.exe'
  } else if (shouldResolvePowerShellFamily) {
    shellPath =
      resolveEffectiveWindowsPowerShell({
        shellFamily: resolvedShellFamily,
        implementation: opts.terminalWindowsPowerShellImplementation,
        pwshAvailable: shouldProbePwsh ? isPwshAvailable() : false
      }) ?? shellPath
  }
  if (
    pathWin32.basename(shellPath).toLowerCase() === 'cmd.exe' &&
    env.ORCA_CODEX_LAUNCH_PREFLIGHT
  ) {
    env[ORCA_CODEX_LAUNCH_PREFLIGHT_CMD_QUOTE_ENV] = '"'
  }
  const windowsFallbackAttempts = buildWindowsPowerShellSpawnAttempts({
    shellPath,
    cwd: spawnCwd,
    defaultCwd: resolveDaemonPtyDefaultCwd(),
    wslContext: resolvedWslContext,
    startupCommand: opts.command
  })
  const primaryAttempt = windowsFallbackAttempts[0]
  if (primaryAttempt) {
    shellPath = primaryAttempt.shellPath
    shellArgs = primaryAttempt.shellArgs
    spawnCwd = primaryAttempt.effectiveCwd
    validationCwd = primaryAttempt.validationCwd
    startupCommandDeliveredInShellArgs = primaryAttempt.startupCommandDeliveredInShellArgs
  } else {
    const resolved = resolveWindowsShellLaunchArgs(
      shellPath,
      spawnCwd,
      resolveDaemonPtyDefaultCwd(),
      resolvedWslContext,
      opts.command,
      env.ORCA_CODEX_LAUNCH_PREFLIGHT
    )
    shellArgs = resolved.shellArgs
    spawnCwd = resolved.effectiveCwd
    validationCwd = resolved.validationCwd
    startupCommandDeliveredInShellArgs = resolved.startupCommandDeliveredInShellArgs === true
  }
  if (isWindowsGitBashShellPath(shellPath)) {
    env.CHERE_INVOKING ??= '1'
  }
  const codexHomeWslInfo = env.CODEX_HOME ? parseWslPath(env.CODEX_HOME) : null
  if (pathWin32.basename(shellPath).toLowerCase() === 'wsl.exe') {
    if (codexHomeWslInfo) {
      const launchWslDistro = resolvedWslContext?.distro
      if (launchWslDistro && launchWslDistro !== codexHomeWslInfo.distro) {
        delete env.CODEX_HOME
        delete env.ORCA_CODEX_HOME
      } else {
        env.CODEX_HOME = codexHomeWslInfo.linuxPath
        env.ORCA_CODEX_HOME = codexHomeWslInfo.linuxPath
        addWslEnvKeys(env, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
        if (!launchWslDistro) {
          const resolved = resolveWindowsShellLaunchArgs(
            shellPath,
            requestedCwd,
            resolveDaemonPtyDefaultCwd(),
            { distro: codexHomeWslInfo.distro },
            opts.command,
            env.ORCA_CODEX_LAUNCH_PREFLIGHT
          )
          shellArgs = resolved.shellArgs
          spawnCwd = resolved.effectiveCwd
          validationCwd = resolved.validationCwd
          startupCommandDeliveredInShellArgs = resolved.startupCommandDeliveredInShellArgs === true
        }
      }
    } else if (isHostCodexHomeForWsl(env.CODEX_HOME)) {
      delete env.CODEX_HOME
      delete env.ORCA_CODEX_HOME
    } else if (env.CODEX_HOME) {
      addWslEnvKeys(env, ['CODEX_HOME', 'ORCA_CODEX_HOME'])
    }
    if (env.CLAUDE_CONFIG_DIR) {
      addWslEnvKeys(env, ['CLAUDE_CONFIG_DIR'])
    }
    if (env[ORCA_HERMES_STARTUP_QUERY_ENV] !== undefined) {
      addWslEnvKeys(env, [ORCA_HERMES_STARTUP_QUERY_ENV])
    }
    addOrcaWslInteropEnv(env)
  } else if (codexHomeWslInfo || isWslCodexHomeForHost(env.CODEX_HOME)) {
    delete env.CODEX_HOME
    delete env.ORCA_CODEX_HOME
  }
  return {
    shellPath,
    shellArgs,
    spawnCwd,
    validationCwd,
    windowsFallbackAttempts,
    startupCommandDeliveredInShellArgs
  }
}

function resolveUnixLaunchPlan(args: {
  opts: DaemonPtyLaunchOptions
  env: Record<string, string>
  shellPath: string
  requestedCwd: string
  isCodexStartupCommand: boolean
}): Omit<DaemonPtyLaunchPlan, 'env' | 'startupAgentRecognition'> {
  const { opts, env, requestedCwd, isCodexStartupCommand } = args
  deleteRequestedDaemonEnvKeys(env, opts.envToDelete)
  if (opts.env?.TERM) {
    env.TERM = opts.env.TERM
  }
  const preferredShellPath = args.shellPath
  const shellPath = resolveUnixShellPath(preferredShellPath)
  if (shellPath !== preferredShellPath) {
    env.SHELL = shellPath
    console.warn(
      `[daemon/pty] Preferred shell "${preferredShellPath}" is unavailable, fell back to "${shellPath}"`
    )
  }
  const waitsForShellReady =
    Boolean(opts.command) &&
    (!isCodexStartupCommand ||
      shouldUseShellReadyStartupDelivery({
        command: opts.command as string,
        startupCommandDelivery: opts.startupCommandDelivery
      }))
  delete env.ORCA_SHELL_FEATURES
  const shellLaunch = getShellLaunchConfig(
    shellPath,
    selectShellStartupFeatures({
      shellPath,
      env,
      hasStartupCommand: Boolean(opts.command),
      waitsForShellReady,
      emitsStartupIdentity: waitsForShellReady
    })
  )
  Object.assign(env, shellLaunch.env)
  return {
    shellPath,
    shellArgs: shellLaunch.args ?? ['-l'],
    spawnCwd: requestedCwd,
    validationCwd: requestedCwd,
    windowsFallbackAttempts: [],
    startupCommandDeliveredInShellArgs: false
  }
}

export function createDaemonPtyLaunchPlan(opts: DaemonPtyLaunchOptions): DaemonPtyLaunchPlan {
  const env = createDaemonPtyEnvironment(opts)
  const resolvedWslContext = resolveWslSessionContext(opts)
  const initialShellPath = resolvedWslContext
    ? 'wsl.exe'
    : opts.shellOverride || resolvePtyShellPath(env)
  const startupAgentRecognition = recognizeAgentProcessFromCommandLine(opts.command)
  const requestedCwd = opts.cwd || resolveDaemonPtyDefaultCwd()
  if (opts.command && startupAgentRecognition) {
    assertSafeAgentStartupCwd(requestedCwd, opts.command)
  }
  const launch =
    process.platform === 'win32'
      ? resolveWindowsLaunchPlan({
          opts,
          env,
          shellPath: initialShellPath,
          requestedCwd,
          resolvedWslContext
        })
      : resolveUnixLaunchPlan({
          opts,
          env,
          shellPath: initialShellPath,
          requestedCwd,
          isCodexStartupCommand: startupAgentRecognition?.agent === 'codex'
        })
  finalizeDaemonPtyEnvironment(env, opts, launch.shellPath)
  return { env, startupAgentRecognition, ...launch }
}
