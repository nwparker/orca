import { execFileSync } from 'child_process'

export function signalForegroundProcessGroup(pid: number, signal: string): boolean {
  if (process.platform === 'win32' || !Number.isInteger(pid) || pid <= 0) {
    return false
  }
  const processGroupId = getForegroundProcessGroupId(pid)
  if (!processGroupId || processGroupId <= 0) {
    return false
  }
  try {
    process.kill(-processGroupId, signal)
    return true
  } catch {
    return false
  }
}

function getForegroundProcessGroupId(pid: number): number | null {
  try {
    const output = execFileSync('ps', ['-o', 'tpgid=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1000
    })
    const parsed = Number.parseInt(output.trim(), 10)
    return Number.isInteger(parsed) ? parsed : null
  } catch {
    return null
  }
}
