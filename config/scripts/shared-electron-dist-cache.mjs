import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import path from 'node:path'
import { cloneTree } from './apfs-clone-copy.mjs'

const IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
// Sibling of path.txt, never inside dist: an install replaces dist wholesale.
const MARKER_FILENAME = '.orca-shared-dist'

/**
 * Where sibling worktrees of one repository keep their shared extracted Electron.
 *
 * Null means "install normally". Only macOS gets an entry, because the whole point is clonefile:
 * on any other filesystem a shared entry would cost a second full copy instead of saving one.
 */
export function resolveSharedElectronDistEntry(options) {
  const { repoRoot, version, targetPlatform, targetArch } = options
  const env = options.env ?? process.env
  if ((options.hostPlatform ?? process.platform) !== 'darwin') {
    return null
  }
  // Packaging jobs get a fresh checkout per run, so a cache only adds a failure mode.
  if (env.CI === '1' || env.CI === 'true') {
    return null
  }
  if (![version, targetPlatform, targetArch].every((part) => IDENTITY_PATTERN.test(part ?? ''))) {
    return null
  }
  let gitCommonDir
  try {
    gitCommonDir = resolveGitCommonDir(repoRoot, options.execFile ?? execFileSync)
  } catch {
    return null // Folder workspace, or no Git on PATH.
  }
  const cacheRoot = path.join(gitCommonDir, 'orca-cache', 'electron')
  return {
    cacheRoot,
    entryPath: path.join(cacheRoot, `${version}-${targetPlatform}-${targetArch}`),
    markerPath: path.join(options.electronPackageDir, MARKER_FILENAME)
  }
}

export function resolveGitCommonDir(repoRoot, execFile = execFileSync) {
  const rawPath = execFile('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore']
  }).trim()
  if (!rawPath) {
    throw new Error('Git returned an empty common directory')
  }
  return path.resolve(repoRoot, rawPath)
}

/** True once this worktree's dist is already a clone of the current cache entry. */
export function hasAdoptedSharedElectronDist(entry) {
  try {
    return readFileSync(entry.markerPath, 'utf8') === path.basename(entry.entryPath)
  } catch {
    return false
  }
}

export function recordAdoptedSharedElectronDist(entry, write) {
  try {
    write(entry.markerPath, path.basename(entry.entryPath))
  } catch {
    // The marker is only an optimization: a missing one costs one extra clone.
  }
}

/**
 * Clone a validated cache entry to `stagePath`. Deliberately never falls back to a byte copy --
 * without clonefile the caller is better off with its normal install, which this must not slow down.
 */
export function cloneSharedElectronDist(entry, stagePath, { version, platformPath }) {
  if (!isUsableElectronDist(entry.entryPath, version, platformPath)) {
    return false
  }
  try {
    cloneTree(entry.entryPath, stagePath)
  } catch {
    return false
  }
  return isUsableElectronDist(stagePath, version, platformPath)
}

/**
 * Publish this worktree's dist as the shared entry, best effort.
 *
 * No lock: staging names are unique and `rename` onto a populated directory fails with ENOTEMPTY,
 * so a concurrent publisher either wins the rename or cleans up its own staging tree. Neither can
 * observe a half-written entry, and a usable entry already in place is never overwritten.
 */
export function publishSharedElectronDist(distPath, entry, options = {}) {
  const { version, platformPath } = options
  const uuid = options.uuid ?? randomUUID
  if (existsSync(entry.entryPath)) {
    // Without an identity to check against, "unusable" is unknowable -- never discard on a guess.
    if (!version || !platformPath || isUsableElectronDist(entry.entryPath, version, platformPath)) {
      return false
    }
    // Left in place, an entry that fails validation makes every sibling worktree re-download
    // forever. Renaming it out of the way first keeps any in-flight clone reading a whole tree.
    if (!discardElectronDistEntry(entry.entryPath, uuid)) {
      return false
    }
  }
  const stagePath = `${entry.entryPath}.staging-${process.pid}-${uuid()}`
  try {
    mkdirSync(entry.cacheRoot, { recursive: true })
    ;(options.clone ?? cloneTree)(distPath, stagePath)
    renameSync(stagePath, entry.entryPath)
    return true
  } catch {
    rmSync(stagePath, { recursive: true, force: true })
    return false
  }
}

function discardElectronDistEntry(entryPath, uuid) {
  const quarantinePath = `${entryPath}.unusable-${process.pid}-${uuid()}`
  try {
    renameSync(entryPath, quarantinePath)
  } catch {
    return false // Another worktree is already replacing it.
  }
  rmSync(quarantinePath, { recursive: true, force: true })
  return true
}

export function isUsableElectronDist(distPath, version, platformPath) {
  try {
    if (!lstatSync(distPath).isDirectory()) {
      return false
    }
    const installedVersion = readFileSync(path.join(distPath, 'version'), 'utf8')
      .trim()
      .replace(/^v/, '')
    return installedVersion === version && existsSync(path.join(distPath, platformPath))
  } catch {
    return false
  }
}
