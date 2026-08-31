import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLONE_ARGS, cloneOrCopyTree, cloneTree } from './apfs-clone-copy.mjs'

const roots: string[] = []

afterEach(() => {
  while (roots.length > 0) {
    rmSync(roots.pop()!, { recursive: true, force: true })
  }
})

function makeTree(): { root: string; source: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'orca-clone-'))
  roots.push(root)
  const source = path.join(root, 'source')
  mkdirSync(path.join(source, 'nested'), { recursive: true })
  writeFileSync(path.join(source, 'nested', 'file'), 'contents')
  symlinkSync(path.join('nested', 'file'), path.join(source, 'relative-link'))
  return { root, source }
}

describe('cloneTree', () => {
  it('clones a tree and keeps relative symlinks unresolved', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'clone')
    cloneTree(source, destination)
    expect(readFileSync(path.join(destination, 'nested', 'file'), 'utf8')).toBe('contents')
    expect(readlinkSync(path.join(destination, 'relative-link'))).toBe(path.join('nested', 'file'))
  })

  it('removes the partial tree cp leaves behind, then rethrows', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'clone')
    const removePartial = vi.fn()
    const execFile = vi.fn(() => {
      throw new Error('clonefile not supported')
    })
    expect(() => cloneTree(source, destination, { execFile, removePartial })).toThrow(
      'clonefile not supported'
    )
    expect(removePartial).toHaveBeenCalledWith(destination)
  })

  it('refuses to run off macOS instead of silently copying', () => {
    const { root, source } = makeTree()
    expect(() => cloneTree(source, path.join(root, 'clone'), { platform: 'linux' })).toThrow(
      /only available on macOS/
    )
  })

  it('never follows symlinks, so Electron.framework survives the copy', () => {
    expect(CLONE_ARGS).toContain('-P')
  })
})

describe('cloneOrCopyTree', () => {
  it('reports the clone when the filesystem supports it', () => {
    const { root, source } = makeTree()
    const result = cloneOrCopyTree(source, path.join(root, 'clone'))
    expect(result).toEqual({ cloned: true, cloneError: null })
    expect(existsSync(path.join(root, 'clone', 'nested', 'file'))).toBe(true)
  })

  it('falls back to a full copy when cloning fails', () => {
    const { root, source } = makeTree()
    const destination = path.join(root, 'clone')
    const cloneError = new Error('cross-device clone')
    const clone = vi.fn(() => {
      throw cloneError
    })
    expect(cloneOrCopyTree(source, destination, { clone })).toEqual({ cloned: false, cloneError })
    expect(readFileSync(path.join(destination, 'nested', 'file'), 'utf8')).toBe('contents')
    expect(readlinkSync(path.join(destination, 'relative-link'))).toBe(path.join('nested', 'file'))
  })

  it('copies directly off macOS without attempting a clone', () => {
    const { root, source } = makeTree()
    const clone = vi.fn()
    expect(cloneOrCopyTree(source, path.join(root, 'clone'), { clone, platform: 'win32' })).toEqual(
      {
        cloned: false,
        cloneError: null
      }
    )
    expect(clone).not.toHaveBeenCalled()
    expect(existsSync(path.join(root, 'clone', 'nested', 'file'))).toBe(true)
  })
})
