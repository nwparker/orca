import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { opendirMock, rmMock, statMock, writeFileMock, randomUUIDMock } = vi.hoisted(() => ({
  opendirMock: vi.fn(),
  rmMock: vi.fn(),
  statMock: vi.fn(),
  writeFileMock: vi.fn(),
  randomUUIDMock: vi.fn(() => '00000000-0000-4000-8000-000000000000')
}))

vi.mock('node:fs/promises', () => ({
  opendir: opendirMock,
  rm: rmMock,
  stat: statMock,
  writeFile: writeFileMock
}))

vi.mock('node:crypto', () => ({ randomUUID: randomUUIDMock }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' }
}))

vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: vi.fn()
}))

import {
  cleanupExpiredLocalClipboardImages,
  saveClipboardImageBufferAsTempFile
} from './clipboard-image-temp-file'

function tempDirectory(entries: { isFile: () => boolean; name: string }[]) {
  return {
    async *[Symbol.asyncIterator]() {
      yield* entries
    },
    close: vi.fn().mockResolvedValue(undefined)
  }
}

describe('local clipboard image temp files', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1760000000000)
    opendirMock.mockReset()
    rmMock.mockReset().mockResolvedValue(undefined)
    statMock.mockReset()
    writeFileMock.mockReset().mockResolvedValue(undefined)
    randomUUIDMock.mockClear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('creates a non-overwritable owner-only image file', async () => {
    const png = Buffer.from([1, 2, 3])

    await expect(saveClipboardImageBufferAsTempFile(png)).resolves.toBe(
      '/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png'
    )

    expect(writeFileMock).toHaveBeenCalledWith(
      '/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png',
      png,
      { flag: 'wx', mode: 0o600 }
    )
  })

  it('removes a saved image after its ownership window expires', async () => {
    vi.useFakeTimers()

    await saveClipboardImageBufferAsTempFile(Buffer.from([1, 2, 3]))
    expect(rmMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)

    expect(rmMock).toHaveBeenCalledWith(
      '/tmp/orca-paste-1760000000000-00000000-0000-4000-8000-000000000000.png',
      { force: true }
    )
  })

  it('removes only expired owned image files during startup cleanup', async () => {
    const directory = tempDirectory([
      { isFile: () => true, name: 'orca-paste-expired.png' },
      { isFile: () => true, name: 'orca-paste-recent.png' },
      { isFile: () => true, name: 'other-app.png' },
      { isFile: () => false, name: 'orca-paste-directory.png' }
    ])
    opendirMock.mockResolvedValue(directory)
    statMock.mockImplementation(async (filePath: string) => ({
      mtimeMs: filePath.endsWith('expired.png') ? 1760000000000 - 60 * 60 * 1000 : 1760000000000
    }))

    await cleanupExpiredLocalClipboardImages(1760000000000)

    expect(rmMock).toHaveBeenCalledOnce()
    expect(rmMock).toHaveBeenCalledWith('/tmp/orca-paste-expired.png', { force: true })
    expect(statMock).not.toHaveBeenCalledWith('/tmp/other-app.png')
    expect(directory.close).toHaveBeenCalledOnce()
  })
})
