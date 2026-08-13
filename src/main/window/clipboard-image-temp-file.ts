import type { Dir } from 'node:fs'
import { opendir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { app } from 'electron'
import { requireSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { assertClipboardImageByteLengthWithinLimit } from '../../shared/clipboard-image'

export type SaveClipboardImageAsTempFileArgs = {
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
}

const REMOTE_CLIPBOARD_IMAGE_TEMP_DIR = '/tmp'
const LOCAL_CLIPBOARD_IMAGE_TTL_MS = 60 * 60 * 1000
const LOCAL_CLIPBOARD_IMAGE_CLEANUP_CONCURRENCY = 8
const CLIPBOARD_IMAGE_FILE_PREFIX = 'orca-paste-'

function joinRemotePath(basePath: string, fileName: string): string {
  if (isWindowsAbsolutePathLike(basePath)) {
    return path.win32.join(basePath, fileName)
  }
  return path.posix.join(basePath, fileName)
}

export async function saveClipboardImageBufferAsTempFile(
  buffer: Buffer,
  args?: SaveClipboardImageAsTempFileArgs
): Promise<string> {
  assertClipboardImageByteLengthWithinLimit(buffer.byteLength)

  const fileName = `${CLIPBOARD_IMAGE_FILE_PREFIX}${Date.now()}-${randomUUID()}.png`

  if (args?.connectionId) {
    const provider = requireSshFilesystemProvider(args.connectionId)
    const remoteTempDir = (await provider.getTempDir?.()) ?? REMOTE_CLIPBOARD_IMAGE_TEMP_DIR
    const remotePath = joinRemotePath(remoteTempDir, fileName)
    // Why: SSH terminal agents run on the remote host, so the pasted path must
    // name a remote file. The provider's base64 path writes binary bytes via SFTP.
    await provider.writeFileBase64(remotePath, buffer.toString('base64'))
    return remotePath
  }

  const tempPath = path.join(app.getPath('temp'), fileName)
  await writeFile(tempPath, buffer, { flag: 'wx', mode: 0o600 })
  scheduleLocalClipboardImageCleanup(tempPath)
  return tempPath
}

export async function cleanupExpiredLocalClipboardImages(nowMs = Date.now()): Promise<void> {
  const tempDir = app.getPath('temp')
  let directory: Dir
  try {
    directory = await opendir(tempDir)
  } catch {
    return
  }

  const pending = new Set<Promise<void>>()
  try {
    for await (const entry of directory) {
      if (!entry.isFile() || !entry.name.startsWith(CLIPBOARD_IMAGE_FILE_PREFIX)) {
        continue
      }
      const cleanup = cleanupExpiredLocalClipboardImage(path.join(tempDir, entry.name), nowMs)
      pending.add(cleanup)
      void cleanup.finally(() => pending.delete(cleanup))
      if (pending.size >= LOCAL_CLIPBOARD_IMAGE_CLEANUP_CONCURRENCY) {
        await Promise.race(pending)
      }
    }
  } catch {
    // Best-effort cleanup must not block clipboard handler registration.
  } finally {
    await directory.close().catch(() => undefined)
  }
  await Promise.all(pending)
}

async function cleanupExpiredLocalClipboardImage(filePath: string, nowMs: number): Promise<void> {
  try {
    const fileStats = await stat(filePath)
    if (nowMs - fileStats.mtimeMs >= LOCAL_CLIPBOARD_IMAGE_TTL_MS) {
      await rm(filePath, { force: true })
    }
  } catch {
    // Stale clipboard images should not make startup cleanup noisy.
  }
}

function scheduleLocalClipboardImageCleanup(filePath: string): void {
  const timer = setTimeout(() => {
    void rm(filePath, { force: true }).catch(() => undefined)
  }, LOCAL_CLIPBOARD_IMAGE_TTL_MS)
  timer.unref?.()
}
