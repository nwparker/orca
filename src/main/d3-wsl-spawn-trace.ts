// Bench only: logs every wsl.exe child with its result, to find what triggers E_UNEXPECTED.
import childProcess from 'node:child_process'

const t0 = Date.now()
let seq = 0
function isWsl(file: unknown): boolean {
  return typeof file === 'string' && /wsl(host)?\.exe$/i.test(file)
}
function brief(args: unknown): string {
  return Array.isArray(args) ? args.join(' ').replace(/\s+/g, ' ').slice(0, 220) : ''
}
function log(line: string): void {
  process.stderr.write(`[d3-wsl] +${Date.now() - t0} ${line}\n`)
}
for (const name of ['spawn', 'execFile'] as const) {
  const original = childProcess[name] as (...args: unknown[]) => childProcess.ChildProcess
  Object.defineProperty(childProcess, name, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      if (!isWsl(args[0])) {
        return original(...args)
      }
      const id = ++seq
      const opts = args.find((a, i) => i > 0 && a && typeof a === 'object' && !Array.isArray(a)) as
        | { cwd?: string; env?: Record<string, string>; detached?: boolean; windowsHide?: boolean }
        | undefined
      log(
        `#${id} ${name} cwd=${opts?.cwd ?? '-'} detached=${opts?.detached ?? false} wslenv=${opts?.env?.WSLENV ?? '-'} ${brief(args[1])}`
      )
      const child = original(...args)
      let out = ''
      child.stdout?.on('data', (d: Buffer | string) => {
        if (out.length < 200) out += String(d).replace(/\0/g, '')
      })
      child.on('exit', (code) => log(`#${id} exit=${code} ${out.replace(/\s+/g, ' ').slice(0, 120)}`))
      return child
    }
  })
}

for (const name of ['spawnSync', 'execFileSync'] as const) {
  const original = childProcess[name] as (...args: unknown[]) => unknown
  Object.defineProperty(childProcess, name, {
    configurable: true,
    writable: true,
    value: (...args: unknown[]) => {
      if (!isWsl(args[0])) {
        return original(...args)
      }
      const id = ++seq
      const start = Date.now()
      log(`#${id} ${name} ${brief(args[1])}`)
      try {
        const result = original(...args) as { status?: number; error?: Error; stdout?: unknown } | Buffer | string
        const status = typeof result === 'object' && result && 'status' in result ? result.status : 'ok'
        const err = typeof result === 'object' && result && 'error' in result ? result.error?.message : ''
        log(`#${id} sync-exit=${String(status)} ms=${Date.now() - start} ${err ?? ''}`)
        return result
      } catch (error) {
        log(`#${id} sync-throw ms=${Date.now() - start} ${String(error).slice(0, 120)}`)
        throw error
      }
    }
  })
}
