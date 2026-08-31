import { execFileSync } from 'node:child_process'
import { cpSync, rmSync } from 'node:fs'

const MACOS_CP = '/bin/cp'
// -c asks for clonefile(2), so the destination shares APFS blocks with the source until one side is
// written. -P keeps Electron.framework's relative symlinks as symlinks; resolving them breaks
// Chromium's bundle lookup.
export const CLONE_ARGS = Object.freeze(['-c', '-R', '-P'])

/** Block-level copy. Throws unless the destination genuinely shares blocks with the source. */
export function cloneTree(sourcePath, destinationPath, options = {}) {
  const execFile = options.execFile ?? execFileSync
  const removePartial = options.removePartial ?? removeTree
  if ((options.platform ?? process.platform) !== 'darwin') {
    throw new Error('APFS clone is only available on macOS')
  }
  try {
    execFile(MACOS_CP, [...CLONE_ARGS, sourcePath, destinationPath], { stdio: 'ignore' })
  } catch (cloneError) {
    // cp can leave a partial tree behind when clonefile fails part-way through a directory.
    removePartial(destinationPath)
    throw cloneError
  }
}

/** Clone when the filesystem allows it, otherwise fall back to a full byte copy. */
export function cloneOrCopyTree(sourcePath, destinationPath, options = {}) {
  const copy = options.copy ?? copyTreeVerbatim
  if ((options.platform ?? process.platform) !== 'darwin') {
    copy(sourcePath, destinationPath)
    return { cloned: false, cloneError: null }
  }
  try {
    ;(options.clone ?? cloneTree)(sourcePath, destinationPath, options)
    return { cloned: true, cloneError: null }
  } catch (cloneError) {
    copy(sourcePath, destinationPath)
    return { cloned: false, cloneError }
  }
}

function copyTreeVerbatim(sourcePath, destinationPath) {
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true
  })
}

function removeTree(targetPath) {
  rmSync(targetPath, { recursive: true, force: true })
}
