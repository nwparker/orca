import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { resolveAbsoluteDirOverride } from '../../shared/absolute-dir-override'
import {
  isReasonixStorageSessionId,
  reasonixSessionLayout
} from '../../shared/reasonix-session-paths'
import { sessionRootDirs } from './session-scanner-roots'
import type { AiVaultAgentSource } from './session-scanner-agent-sources'

export const REASONIX_AGENT_SOURCE: AiVaultAgentSource = {
  rootDirs: (options, wslHomeDirs) => {
    if (!options.includeReasonixHistory) {
      return []
    }
    const platform = options.platform ?? process.platform
    const defaultHome =
      platform === 'win32'
        ? join(process.env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming'), 'reasonix')
        : join(homedir(), '.reasonix')
    const configHome = resolveAbsoluteDirOverride(process.env.REASONIX_HOME, defaultHome, platform)
    const stateHome = resolveAbsoluteDirOverride(
      process.env.REASONIX_STATE_HOME,
      configHome,
      platform
    )
    return sessionRootDirs(
      options.reasonixProjectsDir ?? join(stateHome, 'projects'),
      wslHomeDirs,
      ['.reasonix', 'projects']
    )
  },
  extensions: ['.frames'],
  filePredicate: (path) => reasonixSessionLayout(path) !== null,
  contentDependencyPath: (path) => join(dirname(path), 'manifest.json'),
  directoryPredicate: (name, depth) =>
    depth === 0
      ? !name.startsWith('.')
      : depth === 1
        ? name === 'sessions-v4'
        : depth === 2 && isReasonixStorageSessionId(name)
}
