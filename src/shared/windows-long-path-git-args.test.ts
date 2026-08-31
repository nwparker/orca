import { describe, expect, it } from 'vitest'

import { windowsLongPathGitArgs } from './windows-long-path-git-args'
import { windowsParallelCheckoutGitArgs } from './windows-parallel-checkout-git-args'

describe('windowsLongPathGitArgs', () => {
  it('enables long paths for a Windows drive path', () => {
    expect(windowsLongPathGitArgs('C:\\Users\\dev\\repo', 'win32')).toEqual([
      '-c',
      'core.longpaths=true'
    ])
  })

  it.each(['darwin', 'linux'] as const)('returns nothing on %s', (platform) => {
    expect(windowsLongPathGitArgs('/home/dev/repo', platform)).toEqual([])
  })

  it.each(['\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', '\\\\wsl$\\Ubuntu\\home\\dev\\repo'])(
    'returns nothing for the WSL UNC path %s',
    (cwd) => {
      expect(windowsLongPathGitArgs(cwd, 'win32')).toEqual([])
    }
  )

  it('never mutates the shared constant', () => {
    const first = windowsLongPathGitArgs('C:\\repo', 'win32')
    first.push('--bogus')
    expect(windowsLongPathGitArgs('C:\\repo', 'win32')).toEqual(['-c', 'core.longpaths=true'])
  })
})

describe('windowsParallelCheckoutGitArgs', () => {
  it('enables all logical checkout workers for a native Windows drive path', () => {
    expect(windowsParallelCheckoutGitArgs('C:\\Users\\dev\\repo', 'win32')).toEqual([
      '-c',
      'core.fscache=false',
      '-c',
      'checkout.workers=-1'
    ])
  })

  it('enables workers for a native Windows UNC share', () => {
    expect(windowsParallelCheckoutGitArgs('\\\\server\\share\\repo', 'win32')).toEqual([
      '-c',
      'core.fscache=false',
      '-c',
      'checkout.workers=-1'
    ])
  })

  it.each(['darwin', 'linux'] as const)('returns nothing on %s', (platform) => {
    expect(windowsParallelCheckoutGitArgs('/home/dev/repo', platform)).toEqual([])
  })

  it.each(['\\\\wsl.localhost\\Ubuntu\\home\\dev\\repo', '\\\\wsl$\\Ubuntu\\home\\dev\\repo'])(
    'keeps the default worker policy for the WSL ext4 UNC path %s',
    (cwd) => {
      expect(windowsParallelCheckoutGitArgs(cwd, 'win32')).toEqual([])
    }
  )

  it('uses the all-worker pool for a WSL UNC path backed by DrvFS', () => {
    expect(
      windowsParallelCheckoutGitArgs('\\\\wsl.localhost\\Ubuntu\\mnt\\c\\repo', 'win32')
    ).toEqual(['-c', 'checkout.workers=-1'])
  })

  it('keeps the default worker policy for an ext4 POSIX cwd routed through WSL', () => {
    expect(windowsParallelCheckoutGitArgs('/home/dev/repo', 'win32', 'Ubuntu')).toEqual([])
  })

  it('uses the all-worker pool for an explicitly WSL-routed DrvFS path', () => {
    expect(windowsParallelCheckoutGitArgs('/mnt/c/repo', 'win32', 'Ubuntu')).toEqual([
      '-c',
      'checkout.workers=-1'
    ])
  })

  it('uses the all-worker pool when a Windows drive cwd is routed through WSL', () => {
    // The command runner keeps the Windows spelling for its cwd while it
    // translates that cwd to /mnt/c/... inside the selected distro.
    expect(
      windowsParallelCheckoutGitArgs('C:\\repo', 'win32', 'Ubuntu', {
        nativeWindowsGit: false
      })
    ).toEqual(['-c', 'checkout.workers=-1'])
  })

  it('keeps the FSCache workaround on an ambiguous Windows cwd with a WSL override', () => {
    // A linked worktree can force this C:\ path back to host Git even when a
    // WSL distro override is present, so retain the native safety setting.
    expect(windowsParallelCheckoutGitArgs('C:\\repo', 'win32', 'Ubuntu')).toEqual([
      '-c',
      'core.fscache=false',
      '-c',
      'checkout.workers=-1'
    ])
  })

  it.each(['relative\\repo', '/home/dev/repo', '\\repo'])(
    'returns nothing for a non-absolute native path %s',
    (cwd) => {
      expect(windowsParallelCheckoutGitArgs(cwd, 'win32')).toEqual([])
    }
  )

  it('never mutates the shared constant', () => {
    const first = windowsParallelCheckoutGitArgs('C:\\repo', 'win32')
    first.push('--bogus')
    expect(windowsParallelCheckoutGitArgs('C:\\repo', 'win32')).toEqual([
      '-c',
      'core.fscache=false',
      '-c',
      'checkout.workers=-1'
    ])
  })
})
