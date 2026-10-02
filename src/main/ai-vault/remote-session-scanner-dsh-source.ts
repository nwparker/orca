import { joinRemotePath, type RemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { dshGenerationVersion, selectDshGenerationPaths } from './session-scanner-dsh-generations'
import { parseDshSessionBytes } from './session-scanner-dsh-parser'
import type { RemoteSessionSource } from './remote-session-scanner-types'

export function remoteDshSource(
  home: string,
  platform: RemoteHostPlatform,
  sessionsDir?: string
): RemoteSessionSource {
  return {
    agent: 'dsh',
    rootDir: sessionsDir ?? joinRemotePath(platform, home, '.dsh', 'sessions'),
    extensions: ['.jsonl', '.zstd'],
    filePredicate: (path) => dshGenerationVersion(path) !== null,
    directoryPredicate: (_name, depth) => depth < 2,
    selectFilePaths: selectDshGenerationPaths,
    readAsBytes: true,
    parseDocument: (file, bytes, context) =>
      parseDshSessionBytes(
        file,
        bytes,
        context.hostPlatform.os,
        {
          executionHostId: context.executionHostId,
          executionHostPlatform: context.hostPlatform.os
        },
        undefined,
        context.signal
      ),
    parse: async () => {
      throw new Error('DSH history must be read as bytes on its execution host')
    }
  }
}
