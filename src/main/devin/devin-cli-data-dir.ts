import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'

/** DEVIN_HOME names the CLI data directory; credentials.toml is its sibling. */
export function resolveDevinCliDataDir(): string {
  return resolveAbsoluteDirOverride(
    process.env.DEVIN_HOME,
    join(homedir(), '.local', 'share', 'devin', 'cli')
  )
}

export function resolveDevinTranscriptsDir(): string {
  return join(resolveDevinCliDataDir(), 'transcripts')
}
