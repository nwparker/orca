import { describe, expect, it, vi } from 'vitest'
import { getBranchConflictKindViaExec } from './repo-branch-conflict'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

describe('getBranchConflictKindViaExec', () => {
  it('batches local and remote refs while probing remote names concurrently', async () => {
    const remoteNames = deferred<{ stdout: string }>()
    const remoteRefs = deferred<{ stdout: string }>()
    const calls: string[][] = []
    const exec = vi.fn((args: string[]) => {
      calls.push(args)
      if (args[0] === 'remote') {
        return remoteNames.promise
      }
      if (args[0] === 'for-each-ref') {
        return remoteRefs.promise
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    const resultPromise = getBranchConflictKindViaExec(exec, 'feature/example')
    await Promise.resolve()
    await Promise.resolve()

    expect(calls).toEqual([
      ['for-each-ref', '--format=%(refname)', 'refs/heads/feature/example', 'refs/remotes'],
      ['remote']
    ])

    remoteNames.resolve({ stdout: 'origin\n' })
    remoteRefs.resolve({ stdout: 'refs/remotes/origin/other\n' })
    await expect(resultPromise).resolves.toBeNull()
  })

  it('keeps local conflict precedence without waiting for remote names', async () => {
    const remoteNames = deferred<{ stdout: string }>()
    const calls: string[][] = []
    const exec = vi.fn((args: string[]) => {
      calls.push(args)
      if (args[0] === 'remote') {
        return remoteNames.promise
      }
      if (args[0] === 'for-each-ref') {
        return Promise.resolve({ stdout: 'refs/heads/feature/example\n' })
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await expect(getBranchConflictKindViaExec(exec, 'feature/example')).resolves.toBe('local')
    expect(calls).toEqual([
      ['for-each-ref', '--format=%(refname)', 'refs/heads/feature/example', 'refs/remotes'],
      ['remote']
    ])
  })

  it('falls back to the local probe when the batched refs walk fails', async () => {
    const calls: string[][] = []
    const exec = vi.fn((args: string[]) => {
      calls.push(args)
      if (args[0] === 'for-each-ref') {
        return Promise.reject(new Error('unsupported'))
      }
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: 'abc123\n' })
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await expect(getBranchConflictKindViaExec(exec, 'feature/example')).resolves.toBe('local')
    expect(calls).toContainEqual(['rev-parse', '--verify', 'refs/heads/feature/example'])
  })

  it('matches a remote conflict and honors an allowed base ref', async () => {
    const exec = vi.fn((args: string[]) => {
      if (args[0] === 'remote') {
        return Promise.resolve({ stdout: 'origin\n' })
      }
      if (args[0] === 'for-each-ref') {
        return Promise.resolve({
          stdout: 'refs/remotes/origin/feature/example\nrefs/remotes/origin/main\n'
        })
      }
      throw new Error(`unexpected git command: ${args.join(' ')}`)
    })

    await expect(getBranchConflictKindViaExec(exec, 'feature/example')).resolves.toBe('remote')
    await expect(
      getBranchConflictKindViaExec(exec, 'main', 'origin/main')
    ).resolves.toBeNull()
  })
})
