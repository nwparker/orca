import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileSync: vi.fn()
}))

import { getBaseRefDefault } from './repo'

const repoPath = String.raw`\\wsl.localhost\Ubuntu\home\neil\repo`
const gitOptions = { cwd: repoPath, timeout: 15_000, wslDistro: 'Ubuntu' }

function batchArgs(): string[] {
  return [
    'for-each-ref',
    '--format=%(refname)%00%(symref)%00%(objecttype)%00%(*objecttype)',
    'refs/remotes/origin/HEAD',
    'refs/remotes/origin/main',
    'refs/remotes/origin/master',
    'refs/heads/main',
    'refs/heads/master'
  ]
}

beforeEach(() => {
  gitExecFileAsyncMock.mockReset()
})

describe('WSL default-base ref batching', () => {
  it('returns a valid origin/HEAD target without running the fallback batch', async () => {
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'for-each-ref') {
        return {
          stdout: 'refs/remotes/origin/HEAD\0refs/remotes/origin/main\0commit\0\n'
        }
      }
      throw new Error(`unexpected ${argv.join(' ')}`)
    })

    await expect(getBaseRefDefault(repoPath, { wslDistro: 'Ubuntu' })).resolves.toBe('origin/main')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(batchArgs(), gitOptions)
  })

  it('uses the configured fallback priority even when Git returns refs in another order', async () => {
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'for-each-ref') {
        return {
          stdout:
            'refs/heads/master\0\0commit\0\n' +
            'refs/heads/main\0\0commit\0\n' +
            'refs/remotes/origin/master\0\0commit\0\n' +
            'refs/remotes/origin/main\0\0commit\0\n'
        }
      }
      throw new Error(`unexpected ${argv.join(' ')}`)
    })

    await expect(getBaseRefDefault(repoPath, { wslDistro: 'Ubuntu' })).resolves.toBe('origin/main')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(batchArgs(), gitOptions)
  })

  it('falls back to individual probes when the batch command fails', async () => {
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'for-each-ref') {
        throw new Error('unsupported command')
      }
      if (argv[0] === 'rev-parse' && argv.at(-1) === 'refs/remotes/origin/main') {
        throw new Error('missing main')
      }
      if (argv[0] === 'rev-parse' && argv.at(-1) === 'refs/remotes/origin/master') {
        return { stdout: 'master-sha\n' }
      }
      throw new Error(`unexpected ${argv.join(' ')}`)
    })

    await expect(getBaseRefDefault(repoPath, { wslDistro: 'Ubuntu' })).resolves.toBe(
      'origin/master'
    )

    expect(gitExecFileAsyncMock.mock.calls.map(([argv]) => argv)).toEqual([
      batchArgs(),
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master']
    ])
    for (const [, options] of gitExecFileAsyncMock.mock.calls) {
      expect(options).toEqual(gitOptions)
    }
  })

  it('treats an absent origin/HEAD as a normal batch fallback', async () => {
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'for-each-ref') {
        return { stdout: 'refs/heads/master\0\0commit\0\n' }
      }
      throw new Error(`unexpected ${argv.join(' ')}`)
    })

    await expect(getBaseRefDefault(repoPath, { wslDistro: 'Ubuntu' })).resolves.toBe('master')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(batchArgs(), gitOptions)
  })

  it('accepts an origin/HEAD that points at an annotated commit tag', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'refs/remotes/origin/HEAD\0refs/tags/release\0tag\0commit\n'
    })

    await expect(getBaseRefDefault(repoPath, { wslDistro: 'Ubuntu' })).resolves.toBe(
      'refs/tags/release'
    )
  })

  it('ignores an origin/HEAD that does not resolve to a commit', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout:
        'refs/remotes/origin/HEAD\0refs/tags/blob-release\0blob\0\n' +
        'refs/remotes/origin/main\0\0commit\0\n'
    })

    await expect(getBaseRefDefault(repoPath, { wslDistro: 'Ubuntu' })).resolves.toBe('origin/main')
  })

  it('batches a WSL UNC path even when the caller omits the distro override', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      gitExecFileAsyncMock.mockResolvedValue({
        stdout: 'refs/remotes/origin/HEAD\0refs/remotes/origin/main\0commit\0\n'
      })

      await expect(getBaseRefDefault(repoPath)).resolves.toBe('origin/main')
      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(batchArgs(), {
        cwd: repoPath,
        timeout: 15_000
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('batches native Windows probes with the same exact argv as WSL', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      gitExecFileAsyncMock.mockResolvedValue({
        stdout: 'refs/heads/main\0\0commit\0\n'
      })

      await expect(getBaseRefDefault('C:\\repo')).resolves.toBe('main')
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(batchArgs(), {
        cwd: 'C:\\repo',
        timeout: 15_000
      })
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('falls back to serial native Windows probes when batching is unsupported', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
        if (argv[0] === 'for-each-ref') {
          throw new Error('unsupported command')
        }
        if (argv[0] === 'symbolic-ref') {
          throw new Error('origin/HEAD is unset')
        }
        if (argv[0] === 'rev-parse' && argv.at(-1) === 'refs/remotes/origin/main') {
          throw new Error('missing main')
        }
        if (argv[0] === 'rev-parse' && argv.at(-1) === 'refs/heads/main') {
          return { stdout: 'main-sha\n' }
        }
        throw new Error('missing ref')
      })

      await expect(getBaseRefDefault('C:\\repo')).resolves.toBe('main')
      expect(gitExecFileAsyncMock.mock.calls.map(([argv]) => argv)).toEqual([
        batchArgs(),
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
        ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master'],
        ['rev-parse', '--verify', '--quiet', 'refs/heads/main']
      ])
      for (const [, options] of gitExecFileAsyncMock.mock.calls) {
        expect(options).toEqual({ cwd: 'C:\\repo', timeout: 15_000 })
      }
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('keeps POSIX probes serial', async () => {
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'symbolic-ref') {
        throw new Error('origin/HEAD is unset')
      }
      if (argv[0] === 'rev-parse' && argv.at(-1) === 'refs/heads/main') {
        return { stdout: 'main-sha\n' }
      }
      throw new Error('missing ref')
    })

    await expect(getBaseRefDefault('/repo')).resolves.toBe('main')
    expect(gitExecFileAsyncMock.mock.calls.map(([argv]) => argv)).toEqual([
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'],
      ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/master'],
      ['rev-parse', '--verify', '--quiet', 'refs/heads/main']
    ])
  })
})
