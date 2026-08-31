import * as fsPromises from 'node:fs/promises'
import { win32 } from 'node:path'
import type { Stats } from 'node:fs'

export type WslLinkedWorktreeRoutingFileSystem = {
  stat(path: string): Promise<Pick<Stats, 'isDirectory' | 'isFile'>>
  readFile(path: string): Promise<string>
}

export type WslLinkedWorktreeGitRouteProbeResult = {
  usesHostGit: boolean
  known: boolean
}

export function parseWindowsLinkedGitdir(content: string): string | null {
  const firstLine = content.split(/\r?\n/, 1)[0] ?? ''
  return firstLine.match(/^gitdir:\s*([A-Za-z]:[/\\].*?)\s*$/i)?.[1] ?? null
}

export const defaultWslLinkedWorktreeRoutingFileSystem: WslLinkedWorktreeRoutingFileSystem = {
  stat: (path) => fsPromises.stat(path),
  readFile: (path) => fsPromises.readFile(path, 'utf8')
}

/** Walk parent directories until Git's linked-worktree marker identifies the owner. */
export async function probeWslLinkedWorktreeGitRoute(
  cwd: string,
  fileSystem: WslLinkedWorktreeRoutingFileSystem
): Promise<WslLinkedWorktreeGitRouteProbeResult> {
  let candidate = cwd
  const driveRoot = win32.parse(candidate).root
  while (true) {
    const markerPath = win32.join(candidate, '.git')
    try {
      const marker = await fileSystem.stat(markerPath)
      if (marker.isDirectory()) {
        return { usesHostGit: false, known: true }
      }
      if (marker.isFile()) {
        const usesHostGit = parseWindowsLinkedGitdir(await fileSystem.readFile(markerPath)) !== null
        return { usesHostGit, known: usesHostGit }
      }
      return { usesHostGit: false, known: false }
    } catch (error) {
      const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : null
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw error
      }
    }
    if (candidate === driveRoot) {
      return { usesHostGit: false, known: false }
    }
    candidate = win32.dirname(candidate)
  }
}
