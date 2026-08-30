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
    '--format=%(refname)',
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
      if (argv[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/main\n' }
      }
      if (argv[0] === 'rev-parse') {
        return { stdout: 'abc123\n' }
      }
      throw new Error(`unexpected ${argv.join(' ')}`)
    })

    await expect(getBaseRefDefault(repoPath, { wslDistro: 'Ubuntu' })).resolves.toBe('origin/main')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalledWith(batchArgs(), gitOptions)
  })

  it('uses the configured fallback priority even when Git returns refs in another order', async () => {
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'symbolic-ref') {
        return { stdout: 'refs/remotes/origin/missing\n' }
      }
      if (argv[0] === 'rev-parse') {
        throw new Error('missing origin HEAD target')
      }
      if (argv[0] === 'for-each-ref') {
        return {
          stdout:
            'refs/heads/master\nrefs/heads/main\nrefs/remotes/origin/master\nrefs/remotes/origin/main\n'
        }
      }
      throw new Error(`unexpected ${argv.join(' ')}`)
    })

    await expect(getBaseRefDefault(repoPath, { wslDistro: 'Ubuntu' })).resolves.toBe('origin/main')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(batchArgs(), gitOptions)
  })

  it('falls back to individual probes when the batch command fails', async () => {
    gitExecFileAsyncMock.mockImplementation(async (argv: string[]) => {
      if (argv[0] === 'symbolic-ref' || argv[0] === 'for-each-ref') {
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
      ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
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
      if (argv[0] === 'symbolic-ref') {
        throw new Error('origin/HEAD is unset')
      }
      if (argv[0] === 'for-each-ref') {
        return { stdout: 'refs/heads/master\n' }
      }
      throw new Error(`unexpected ${argv.join(' ')}`)
    })

    await expect(getBaseRefDefault(repoPath, { wslDistro: 'Ubuntu' })).resolves.toBe('master')
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(batchArgs(), gitOptions)
  })

  it('does not batch native probes, preserving their existing execution shape', async () => {
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
