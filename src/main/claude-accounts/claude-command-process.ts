import { spawnProcess, type ChildProcessHandle } from '../../shared/child-process/run-process'
import { resolveClaudeCommand } from '../codex-cli/command'
import { buildWindowsCommandInvocation } from './windows-command-invocation'

const MAX_COMMAND_OUTPUT_CHARS = 4_000
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000
const CLAUDE_AUTH_DENIED_PATTERN =
  /\baccess_denied\b|authorization (?:request )?(?:was )?denied|sign-?in (?:was )?denied|login (?:was )?denied/i

export type ClaudeCommandConfig = {
  windowsPath: string
  linuxPath: string | null
  wslDistro: string | null
}

export type ClaudeCommandOptions = {
  allowFailure?: boolean
  signal?: AbortSignal
  keepStdinOpen?: boolean
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`
}

export function runClaudeCommandProcess(
  args: string[],
  configDir: ClaudeCommandConfig,
  timeoutMs: number,
  options?: ClaudeCommandOptions
): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const command = resolveClaudeInvocation(args, configDir)
    const child = spawnProcess({
      program: command.program,
      args: command.args,
      env: command.env,
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: command.windowsVerbatimArguments,
      stdio: [options?.keepStdinOpen ? 'pipe' : 'ignore', 'pipe', 'pipe']
    })
    const stdout = child.stdout
    const stderr = child.stderr
    if (!stdout || !stderr) {
      if (options?.keepStdinOpen) {
        child.stdin?.destroy()
      }
      child.kill()
      rejectPromise(new Error('Claude command failed to open output streams.'))
      return
    }
    const completesOnExit =
      process.platform === 'win32' &&
      configDir.linuxPath === null &&
      configDir.wslDistro === null &&
      args[0] === 'auth' &&
      args[1] === 'login'
    const completionEvent = completesOnExit ? 'exit' : 'close'
    let settled = false
    let output = ''
    let timeout: ReturnType<typeof setTimeout> | null = null
    let terminationPending = false

    const cleanupListeners = (): void => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = null
      }
      stdout.off('data', appendOutput)
      stderr.off('data', appendOutput)
      child.off('error', onError)
      child.off(completionEvent, onDone)
      options?.signal?.removeEventListener('abort', onAbort)
      if (options?.keepStdinOpen) {
        child.stdin?.destroy()
      }
      if (completesOnExit) {
        stdout.destroy()
        stderr.destroy()
      }
    }
    const settle = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      cleanupListeners()
      callback()
    }
    const killChild = (afterKill: () => void): void => {
      if (terminationPending || settled) {
        return
      }
      terminationPending = true
      terminateClaudeProcess(child, afterKill)
    }
    const appendOutput = (chunk: Buffer): void => {
      output = `${output}${chunk.toString()}`
      if (output.length > MAX_COMMAND_OUTPUT_CHARS) {
        output = output.slice(-MAX_COMMAND_OUTPUT_CHARS)
      }
      if (CLAUDE_AUTH_DENIED_PATTERN.test(output)) {
        killChild(() =>
          settle(() => rejectPromise(new Error('Claude sign-in was denied. Please try again.')))
        )
      }
    }
    const onAbort = (): void => {
      killChild(() => settle(() => rejectPromise(new Error('Claude sign-in was cancelled.'))))
    }
    const onError = (error: Error): void => {
      if (!terminationPending) {
        settle(() => rejectPromise(error))
      }
    }
    const onDone = (code: number | null): void => {
      if (terminationPending) {
        return
      }
      settle(() => {
        if (code === 0 || options?.allowFailure) {
          resolvePromise(output)
          return
        }
        const trimmedOutput = output.trim()
        rejectPromise(
          new Error(
            trimmedOutput
              ? `Claude command failed: ${trimmedOutput}`
              : `Claude command exited with code ${code ?? 'unknown'}.`
          )
        )
      })
    }

    timeout = setTimeout(() => {
      killChild(() =>
        settle(() => rejectPromise(new Error('Claude sign-in took too long to finish.')))
      )
    }, timeoutMs)
    stdout.on('data', appendOutput)
    stderr.on('data', appendOutput)
    child.on('error', onError)
    child.on(completionEvent, onDone)
    if (options?.signal?.aborted) {
      onAbort()
    } else {
      options?.signal?.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function resolveClaudeInvocation(
  args: string[],
  configDir: ClaudeCommandConfig
): {
  program: string
  args: string[]
  env: NodeJS.ProcessEnv
  windowsVerbatimArguments: boolean
} {
  if (configDir.linuxPath && configDir.wslDistro) {
    return {
      program: 'wsl.exe',
      args: [
        '-d',
        configDir.wslDistro,
        '--exec',
        'bash',
        '-lc',
        `export CLAUDE_CONFIG_DIR=${shellQuote(configDir.linuxPath)}; exec claude ${args.map(shellQuote).join(' ')}`
      ],
      env: process.env,
      windowsVerbatimArguments: false
    }
  }
  if (process.platform === 'win32') {
    const invocation = buildWindowsCommandInvocation(resolveClaudeCommand(), args)
    return {
      program: invocation.command,
      args: invocation.args,
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir.windowsPath },
      windowsVerbatimArguments: invocation.windowsVerbatimArguments
    }
  }
  return {
    program: resolveClaudeCommand(),
    args,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir.windowsPath },
    windowsVerbatimArguments: false
  }
}

function terminateClaudeProcess(child: ChildProcessHandle, afterKill: () => void): void {
  if (process.platform === 'win32' && child.pid) {
    const taskkill = spawnProcess({
      program: 'taskkill.exe',
      args: ['/pid', String(child.pid), '/t', '/f'],
      stdio: 'ignore'
    })
    let finished = false
    const finish = (succeeded: boolean): void => {
      if (finished) {
        return
      }
      finished = true
      clearTimeout(taskkillTimeout)
      if (!succeeded) {
        child.kill()
      }
      afterKill()
    }
    const taskkillTimeout = setTimeout(() => {
      taskkill.kill()
      finish(false)
    }, WINDOWS_TASKKILL_TIMEOUT_MS)
    taskkill.once('error', () => finish(false))
    taskkill.once('close', (code) => finish(code === 0))
    return
  }
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid)
      afterKill()
      return
    } catch {
      // The direct child remains the only safe fallback when group lookup fails.
    }
  }
  child.kill()
  afterKill()
}
