import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Fs from 'fs'
import type * as FsPromises from 'fs/promises'
import type * as FilesystemAuth from '../ipc/filesystem-auth'

const { resolveAuthorizedPathMock, statMock, watchMock } = vi.hoisted(() => ({
  resolveAuthorizedPathMock: vi.fn(),
  statMock: vi.fn(),
  watchMock: vi.fn()
}))

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof Fs>('fs')
  return {
    ...actual,
    watch: watchMock
  }
})

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return {
    ...actual,
    stat: statMock
  }
})

vi.mock('../ipc/filesystem-auth', async () => {
  const actual = await vi.importActual<typeof FilesystemAuth>('../ipc/filesystem-auth')
  return {
    ...actual,
    resolveAuthorizedPath: resolveAuthorizedPathMock
  }
})

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: vi.fn()
}))

import { RuntimeFileCommands } from './orca-runtime-files'
import { getSshFilesystemProvider } from '../providers/ssh-filesystem-dispatch'

describe('RuntimeFileCommands', () => {
  const originalPlatform = process.platform

  beforeEach(() => {
    vi.useFakeTimers()
    resolveAuthorizedPathMock.mockReset()
    statMock.mockReset()
    watchMock.mockReset()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform
    })
    vi.useRealTimers()
  })

  it('uses a conservative Node watcher for Windows runtime file watches', async () => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32'
    })

    const store = { getRepo: vi.fn(() => undefined) }
    const close = vi.fn()
    const on = vi.fn()
    let listener: (() => void) | null = null
    watchMock.mockImplementation((_rootPath, _options, callback) => {
      listener = callback
      return { close, on }
    })
    resolveAuthorizedPathMock.mockResolvedValue('C:\\repo')
    statMock.mockResolvedValue({ isDirectory: () => true })

    const commands = new RuntimeFileCommands({
      getRuntimeId: () => 'runtime-1',
      requireStore: () => store,
      resolveWorktreeSelector: vi.fn(async () => ({
        id: 'wt-1',
        repoId: 'repo-1',
        path: 'C:\\repo'
      })),
      resolveRuntimeGitTarget: vi.fn(),
      openFile: vi.fn()
    } as never)
    const onEvents = vi.fn()

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', onEvents)

    expect(watchMock).toHaveBeenCalledWith('C:\\repo', { recursive: true }, expect.any(Function))
    const emit = listener as (() => void) | null
    expect(emit).not.toBeNull()

    emit?.()
    emit?.()
    await vi.advanceTimersByTimeAsync(149)
    expect(onEvents).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(onEvents).toHaveBeenCalledTimes(1)
    expect(onEvents).toHaveBeenCalledWith([{ kind: 'overflow', absolutePath: 'C:\\repo' }])

    unsubscribe()
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('routes mobile and file-explorer commands through the SSH filesystem provider', async () => {
    const provider = {
      listFiles: vi.fn(async () => [
        'src/app.ts',
        'assets/logo.png',
        '../escape',
        'notes/readme.md'
      ]),
      readFile: vi.fn(async () => ({ content: 'hello remote', isBinary: false })),
      stat: vi.fn(async () => ({
        size: 12,
        type: 'file',
        mtime: 123
      })),
      readDir: vi.fn(async () => [{ name: 'src', isDirectory: true, isSymlink: false }]),
      writeFile: vi.fn(async () => {}),
      writeFileBase64: vi.fn(async () => {}),
      writeFileBase64Chunk: vi.fn(async () => {}),
      createFile: vi.fn(async () => {}),
      createDir: vi.fn(async () => {}),
      createDirNoClobber: vi.fn(async () => {}),
      copy: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      deletePath: vi.fn(async () => {}),
      search: vi.fn(async () => ({ matches: [], totalCount: 0, truncated: false })),
      watch: vi.fn(async () => vi.fn())
    }
    vi.mocked(getSshFilesystemProvider).mockReturnValue(provider as never)
    const store = { getRepo: vi.fn(() => ({ id: 'repo-1', connectionId: 'ssh-1' })) }
    const openFile = vi.fn()
    const worktree = {
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/remote/repo',
      git: { path: '/remote/repo', branch: 'main', head: 'abc' }
    }
    const commands = new RuntimeFileCommands({
      getRuntimeId: () => 'runtime-1',
      requireStore: () => store,
      resolveWorktreeSelector: vi.fn(async () => worktree),
      resolveRuntimeGitTarget: vi.fn(async () => ({ worktree, connectionId: 'ssh-1' })),
      openFile
    } as never)

    await expect(commands.listMobileFiles('id:wt-1')).resolves.toMatchObject({
      worktree: 'wt-1',
      rootPath: '/remote/repo',
      totalCount: 4,
      files: [
        { relativePath: 'assets/logo.png', basename: 'logo.png', kind: 'binary' },
        { relativePath: 'notes/readme.md', basename: 'readme.md', kind: 'text' },
        { relativePath: 'src/app.ts', basename: 'app.ts', kind: 'text' }
      ]
    })
    await expect(commands.openMobileFile('id:wt-1', 'assets/logo.png')).resolves.toMatchObject({
      kind: 'binary',
      opened: false
    })
    await expect(commands.openMobileFile('id:wt-1', 'notes/readme.md')).resolves.toMatchObject({
      kind: 'markdown',
      opened: true
    })
    expect(openFile).toHaveBeenCalledWith('wt-1', '/remote/repo/notes/readme.md', 'notes/readme.md')
    await expect(commands.openMobileFile('id:wt-1', '../escape')).rejects.toThrow(
      'invalid_relative_path'
    )
    await expect(commands.readMobileFile('id:wt-1', 'src/app.ts')).resolves.toMatchObject({
      content: 'hello remote',
      truncated: false,
      byteLength: 12
    })

    await expect(commands.readFileExplorerDir('id:wt-1', 'src')).resolves.toEqual([
      { name: 'src', isDirectory: true, isSymlink: false }
    ])
    await expect(commands.readFileExplorerPreview('id:wt-1', 'src/app.ts')).resolves.toEqual({
      content: 'hello remote',
      isBinary: false
    })
    await expect(commands.writeFileExplorerFile('id:wt-1', 'src/app.ts', 'next')).resolves.toEqual({
      ok: true
    })
    await expect(
      commands.writeFileExplorerFileBase64('id:wt-1', 'src/blob.bin', 'YmxvYg==')
    ).resolves.toEqual({ ok: true })
    await expect(
      commands.writeFileExplorerFileBase64Chunk('id:wt-1', 'src/blob.bin', 'Yg==', true)
    ).resolves.toEqual({ ok: true })
    await expect(commands.createFileExplorerFile('id:wt-1', 'src/new.ts')).resolves.toEqual({
      ok: true
    })
    await expect(commands.createFileExplorerDir('id:wt-1', 'src/new-dir')).resolves.toEqual({
      ok: true
    })
    await expect(commands.createFileExplorerDirNoClobber('id:wt-1', 'src/exact')).resolves.toEqual({
      ok: true
    })
    await expect(
      commands.commitFileExplorerUpload('id:wt-1', '.orca/tmp/upload', 'src/upload.bin')
    ).resolves.toEqual({ ok: true })
    await expect(
      commands.renameFileExplorerPath('id:wt-1', 'src/old.ts', 'src/new.ts')
    ).resolves.toEqual({
      ok: true
    })
    await expect(
      commands.copyFileExplorerPath('id:wt-1', 'src/new.ts', 'src/copy.ts')
    ).resolves.toEqual({
      ok: true
    })
    await expect(commands.deleteFileExplorerPath('id:wt-1', 'src/copy.ts', true)).resolves.toEqual({
      ok: true
    })
    await expect(commands.searchRuntimeFiles('id:wt-1', { query: 'hello' })).resolves.toEqual({
      matches: [],
      totalCount: 0,
      truncated: false
    })
    await expect(
      commands.listRuntimeFiles('id:wt-1', { excludePaths: ['node_modules'] })
    ).resolves.toEqual(['src/app.ts', 'assets/logo.png', '../escape', 'notes/readme.md'])
    await expect(commands.listRuntimeMarkdownDocuments('id:wt-1')).resolves.toEqual([
      expect.objectContaining({ relativePath: 'notes/readme.md' })
    ])
    await expect(commands.statRuntimeFile('id:wt-1', 'src/app.ts')).resolves.toEqual({
      size: 12,
      isDirectory: false,
      mtime: 123
    })

    const unsubscribe = await commands.watchFileExplorer('id:wt-1', vi.fn())
    unsubscribe()
    expect(provider.watch).toHaveBeenCalledWith('/remote/repo', expect.any(Function))
    expect(provider.writeFileBase64Chunk).toHaveBeenCalledWith(
      '/remote/repo/src/blob.bin',
      'Yg==',
      true
    )
    expect(provider.copy).toHaveBeenCalledWith(
      '/remote/repo/.orca/tmp/upload',
      '/remote/repo/src/upload.bin'
    )
    expect(provider.deletePath).toHaveBeenCalledWith('/remote/repo/.orca/tmp/upload', false)
    expect(provider.rename).toHaveBeenCalledWith(
      '/remote/repo/src/old.ts',
      '/remote/repo/src/new.ts'
    )
  })

  it('rejects missing SSH providers and unsafe mobile file reads', async () => {
    vi.mocked(getSshFilesystemProvider).mockReturnValue(undefined)
    const store = { getRepo: vi.fn(() => ({ id: 'repo-1', connectionId: 'ssh-1' })) }
    const worktree = {
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/remote/repo',
      git: { path: '/remote/repo', branch: 'main', head: 'abc' }
    }
    const commands = new RuntimeFileCommands({
      getRuntimeId: () => 'runtime-1',
      requireStore: () => store,
      resolveWorktreeSelector: vi.fn(async () => worktree),
      resolveRuntimeGitTarget: vi.fn(async () => ({ worktree, connectionId: 'ssh-1' })),
      openFile: vi.fn()
    } as never)

    await expect(commands.readMobileFile('id:wt-1', 'assets/logo.png')).rejects.toThrow(
      'binary_file'
    )
    await expect(commands.readFileExplorerDir('id:wt-1', '')).rejects.toThrow(
      'remote_filesystem_unavailable'
    )
    await expect(commands.searchRuntimeFiles('id:wt-1', { query: 'x' })).rejects.toThrow(
      'remote_filesystem_unavailable'
    )
    await expect(commands.listRuntimeFiles('id:wt-1')).resolves.toEqual([])
  })
})
