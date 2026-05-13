import { spawn } from 'child_process'
import { dirname } from 'path'
import { ipcMain } from 'electron'
import type { Store } from '../persistence'
import { resolveAuthorizedPath } from './filesystem-auth'

export type NotebookRunResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  error?: string
}

const PYTHON_RUN_TIMEOUT_MS = 60_000
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024

function pythonCandidates(): { command: string; argsPrefix: string[] }[] {
  const configured = process.env.ORCA_NOTEBOOK_PYTHON?.trim()
  const candidates: { command: string; argsPrefix: string[] }[] = []
  if (configured) {
    candidates.push({ command: configured, argsPrefix: [] })
  }
  if (process.platform === 'win32') {
    candidates.push({ command: 'py', argsPrefix: ['-3'] })
  }
  candidates.push({ command: 'python3', argsPrefix: [] }, { command: 'python', argsPrefix: [] })
  return candidates
}

function appendBounded(current: string, chunk: Buffer): string {
  if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) {
    return current
  }
  const next = current + chunk.toString('utf8')
  if (Buffer.byteLength(next) <= MAX_CAPTURE_BYTES) {
    return next
  }
  return `${next.slice(0, MAX_CAPTURE_BYTES)}\n[output truncated]\n`
}

function buildPythonExecutionCode(code: string, preamble: string): string {
  const payload = Buffer.from(JSON.stringify({ code, preamble }), 'utf8').toString('base64')
  return [
    'import base64, contextlib, io, json, sys, traceback',
    `payload = json.loads(base64.b64decode(${JSON.stringify(payload)}).decode("utf-8"))`,
    'namespace = {"__name__": "__main__"}',
    'try:',
    '    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):',
    '        exec(payload["preamble"], namespace)',
    '    exec(payload["code"], namespace)',
    'except Exception:',
    '    traceback.print_exc()',
    '    sys.exit(1)'
  ].join('\n')
}

async function runPythonCandidate(
  candidate: { command: string; argsPrefix: string[] },
  code: string,
  preamble: string,
  cwd: string
): Promise<NotebookRunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(
      candidate.command,
      [...candidate.argsPrefix, '-c', buildPythonExecutionCode(code, preamble)],
      {
        cwd,
        windowsHide: true,
        env: process.env
      }
    )
    const timeout = setTimeout(() => {
      if (settled) {
        return
      }
      settled = true
      child.kill()
      resolve({ stdout, stderr, exitCode: null, error: 'Python cell timed out.' })
    }, PYTHON_RUN_TIMEOUT_MS)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout = appendBounded(stdout, chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = appendBounded(stderr, chunk)
    })
    child.on('error', (error) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({ stdout, stderr, exitCode: null, error: error.message })
    })
    child.on('close', (exitCode) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve({ stdout, stderr, exitCode })
    })
  })
}

async function runPythonCell(
  code: string,
  preamble: string,
  cwd: string
): Promise<NotebookRunResult> {
  if (!code.trim() && !preamble.trim()) {
    return { stdout: '', stderr: '', exitCode: 0 }
  }

  let lastError = 'Python was not found.'
  for (const candidate of pythonCandidates()) {
    const result = await runPythonCandidate(candidate, code, preamble, cwd)
    if (!result.error?.includes('ENOENT')) {
      return result
    }
    lastError = result.error
  }
  return { stdout: '', stderr: '', exitCode: null, error: lastError }
}

export function registerNotebookHandlers(store: Store): void {
  ipcMain.handle(
    'notebook:runPythonCell',
    async (
      _event,
      args: { filePath: string; code: string; preamble?: string; connectionId?: string | null }
    ): Promise<NotebookRunResult> => {
      if (args.connectionId) {
        return {
          stdout: '',
          stderr: '',
          exitCode: null,
          error: 'Notebook execution is currently supported for local files only.'
        }
      }
      const filePath = await resolveAuthorizedPath(args.filePath, store)
      // Why: execute relative to the notebook file so local imports and data
      // paths behave the same way users expect from a notebook opened on disk.
      return runPythonCell(args.code, args.preamble ?? '', dirname(filePath))
    }
  )
}
