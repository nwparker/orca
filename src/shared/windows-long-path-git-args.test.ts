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
    'returns nothing for the WSL UNC path %s',
    (cwd) => {
      expect(windowsParallelCheckoutGitArgs(cwd, 'win32')).toEqual([])
    }
  )

  it('returns nothing when a Windows path is explicitly routed through WSL', () => {
    expect(windowsParallelCheckoutGitArgs('C:\\repo', 'win32', 'Ubuntu')).toEqual([])
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
