import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'

// DEVIN_HOME overrides the root containing credentials.toml and the cli directory.
export function resolveDevinCliDataDir(): string {
  const platformDataDir = resolveAbsoluteDirOverride(
    process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_DATA_HOME,
    process.platform === 'win32'
      ? join(homedir(), 'AppData', 'Roaming')
      : join(homedir(), '.local', 'share')
  )
  return join(
    resolveAbsoluteDirOverride(process.env.DEVIN_HOME, join(platformDataDir, 'devin')),
    'cli'
  )
}

export function resolveDevinTranscriptsDir(): string {
  return join(resolveDevinCliDataDir(), 'transcripts')
}
