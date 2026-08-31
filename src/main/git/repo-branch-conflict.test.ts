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
  it('starts remote-name and remote-ref probes together after local absence', async () => {
    const remoteNames = deferred<{ stdout: string }>()
    const remoteRefs = deferred<{ stdout: string }>()
    const calls: string[][] = []
    const exec = vi.fn((args: string[]) => {
      calls.push(args)
      if (args[0] === 'rev-parse') {
        return Promise.resolve({ stdout: '' })
      }
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
      ['rev-parse', '--verify', 'refs/heads/feature/example'],
      ['remote'],
      ['for-each-ref', '--format=%(refname)', 'refs/remotes']
    ])

    remoteNames.resolve({ stdout: 'origin\n' })
    remoteRefs.resolve({ stdout: 'refs/remotes/origin/other\n' })
    await expect(resultPromise).resolves.toBeNull()
  })
})
