import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkIgnoredPaths } from './check-ignored-paths'
import { gitExecFileAsync } from './runner'

vi.mock('./runner', () => ({
  gitExecFileAsync: vi.fn()
}))

const gitExecFileAsyncMock = vi.mocked(gitExecFileAsync)

describe('checkIgnoredPaths', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
  })

  it('returns ignored paths from git check-ignore output', async () => {
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: 'dist/bundle.js\0.env\0dist/bundle.js\0',
      stderr: ''
    })

    await expect(
      checkIgnoredPaths('/repo', ['dist/bundle.js', 'src/index.ts', '.env'])
    ).resolves.toEqual(['dist/bundle.js', '.env'])

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['-c', 'core.quotePath=false', 'check-ignore', '--stdin', '-z'],
      {
        cwd: '/repo',
        stdin: 'dist/bundle.js\0src/index.ts\0.env\0',
        maxBuffer: 10 * 1024 * 1024,
        timeout: 15_000
      }
    )
  })

  it('checks thousands of paths in one process and preserves newline filenames', async () => {
    const paths = Array.from({ length: 5_000 }, (_, index) => `src/generated-${index}.ts`)
    paths[123] = 'src/file\nwith-newline.ts'
    gitExecFileAsyncMock.mockResolvedValue({
      stdout: `${paths[123]}\0${paths.at(-1)}\0`,
      stderr: ''
    })

    await expect(checkIgnoredPaths('/repo', paths)).resolves.toEqual([paths[123], paths.at(-1)])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    const options = gitExecFileAsyncMock.mock.calls[0]?.[1]
    expect(options?.stdin?.split('\0').filter(Boolean)).toEqual(paths)
    expect(options?.timeout).toBe(15_000)
  })

  it('does not launch git for an empty path list', async () => {
    await expect(checkIgnoredPaths('/repo', [])).resolves.toEqual([])
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('treats exit code 1 as no ignored paths', async () => {
    gitExecFileAsyncMock.mockRejectedValue(Object.assign(new Error('no matches'), { code: 1 }))

    await expect(checkIgnoredPaths('/repo', ['src/index.ts'])).resolves.toEqual([])
  })
})
