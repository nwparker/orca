import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { ModelManager } from './model-manager'
import { SPEECH_MODEL_CATALOG, getCatalogModel } from './model-catalog'
import type { SpeechModelState } from '../../shared/speech-types'

const electronMock = vi.hoisted(() => ({
  getPath: vi.fn(() => '/tmp/orca-speech-models-user-data')
}))

vi.mock('electron', () => ({
  app: {
    getPath: electronMock.getPath
  }
}))

type DownloadFileFn = (
  url: string,
  dest: string,
  expectedSize: number,
  modelId: string,
  isAborted: () => boolean
) => Promise<void>

type ExtractArchiveFn = (
  archivePath: string,
  destDir: string,
  modelId: string,
  isAborted: () => boolean
) => Promise<void>

type TestableModelManager = {
  downloadFile: DownloadFileFn
  extractArchive: ExtractArchiveFn
  verifyArchiveSha256: (archivePath: string, expectedSha256: string) => Promise<void>
  modelStates: Map<string, SpeechModelState>
}
type AbortProbe = () => boolean
type FinishDownload = () => void

const MODEL_ID = 'whisper-tiny'

let tempRoot: string

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-model-manager-'))
}

function writeManifestFiles(modelDir: string, modelId = MODEL_ID): void {
  const manifest = getCatalogModel(modelId)
  if (!manifest) {
    throw new Error(`Missing test manifest: ${modelId}`)
  }
  mkdirSync(modelDir, { recursive: true })
  for (const file of manifest.files) {
    writeFileSync(join(modelDir, file), file)
  }
}

function testable(manager: ModelManager): TestableModelManager {
  return manager as unknown as TestableModelManager
}

describe('ModelManager', () => {
  beforeEach(() => {
    tempRoot = createTempDir()
    electronMock.getPath.mockReturnValue(join(tempRoot, 'user-data'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(tempRoot, { recursive: true, force: true })
  })

  it('requires pinned SHA-256 hashes for every catalog archive', () => {
    for (const manifest of SPEECH_MODEL_CATALOG) {
      expect(manifest.archiveSha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('reports model state from the catalog and validates local files', async () => {
    const manager = new ModelManager()
    expect(manager.getModelsDir()).toBe(join(tempRoot, 'user-data', 'speech-models'))

    const modelDir = manager.getModelDir(MODEL_ID)
    writeManifestFiles(modelDir)

    await expect(manager.getModelState(MODEL_ID)).resolves.toEqual({
      id: MODEL_ID,
      status: 'ready'
    })
    await expect(manager.getModelState('missing-model')).resolves.toEqual({
      id: 'missing-model',
      status: 'error',
      error: 'Unknown model'
    })
    expect(() => manager.getModelDir('missing-model')).toThrow('Unknown model: missing-model')

    const states = await manager.getModelStates()
    expect(states).toHaveLength(SPEECH_MODEL_CATALOG.length)
    expect(states.find((state) => state.id === MODEL_ID)).toEqual({
      id: MODEL_ID,
      status: 'ready'
    })
  })

  it('downloads, flattens nested archives, updates state, and deletes models', async () => {
    const manager = new ModelManager(join(tempRoot, 'models'))
    const progress = vi.fn()
    manager.setProgressCallback(progress)

    const downloadFile = vi.spyOn(testable(manager), 'downloadFile').mockResolvedValue(undefined)
    vi.spyOn(testable(manager), 'verifyArchiveSha256').mockResolvedValue(undefined)
    vi.spyOn(testable(manager), 'extractArchive').mockImplementation(
      async (_archivePath, destDir, modelId) => {
        const nestedDir = join(destDir, modelId, 'nested')
        writeManifestFiles(nestedDir, modelId)
      }
    )

    await manager.downloadModel(MODEL_ID)

    expect(downloadFile).toHaveBeenCalledWith(
      getCatalogModel(MODEL_ID)?.downloadUrl,
      join(manager.getModelsDir(), `${MODEL_ID}.tar.bz2`),
      getCatalogModel(MODEL_ID)?.sizeBytes,
      MODEL_ID,
      expect.any(Function)
    )
    await expect(manager.getModelState(MODEL_ID)).resolves.toEqual({
      id: MODEL_ID,
      status: 'ready'
    })
    expect(
      getCatalogModel(MODEL_ID)?.files.every((file) =>
        existsSync(join(manager.getModelDir(MODEL_ID), file))
      )
    ).toBe(true)
    expect(progress).toHaveBeenCalledWith(MODEL_ID, 0)
    expect(progress).toHaveBeenCalledWith(MODEL_ID, 0.95)
    expect(progress).toHaveBeenCalledWith(MODEL_ID, -1)

    await manager.downloadModel(MODEL_ID)
    expect(downloadFile).toHaveBeenCalledTimes(1)

    await manager.deleteModel(MODEL_ID)
    expect(existsSync(manager.getModelDir(MODEL_ID))).toBe(false)
    await expect(manager.getModelState(MODEL_ID)).resolves.toEqual({
      id: MODEL_ID,
      status: 'not-downloaded'
    })
  })

  it('verifies downloaded archive hashes before extraction', async () => {
    const manager = new ModelManager(join(tempRoot, 'models'))
    const archivePath = join(tempRoot, 'model.tar.bz2')
    writeFileSync(archivePath, 'known archive bytes')
    const expected = createHash('sha256').update('known archive bytes').digest('hex')

    await expect(
      testable(manager).verifyArchiveSha256(archivePath, expected)
    ).resolves.toBeUndefined()
    await expect(
      testable(manager).verifyArchiveSha256(archivePath, '0'.repeat(64))
    ).rejects.toThrow(/integrity verification/)
  })

  it('rejects non-HTTPS model downloads', async () => {
    const manager = new ModelManager(join(tempRoot, 'models'))

    await expect(
      testable(manager).downloadFile(
        'http://example.com/model.tar.bz2',
        join(tempRoot, 'model.tar.bz2'),
        1,
        MODEL_ID,
        () => false
      )
    ).rejects.toThrow(/HTTPS/)
  })

  it('surfaces download failures and ignores duplicate active downloads', async () => {
    const manager = new ModelManager(join(tempRoot, 'models'))
    vi.spyOn(testable(manager), 'downloadFile').mockRejectedValueOnce(new Error('network down'))

    await manager.downloadModel(MODEL_ID)

    expect(testable(manager).modelStates.get(MODEL_ID)).toEqual({
      id: MODEL_ID,
      status: 'error',
      error: 'Error: network down'
    })

    let finishDownload: FinishDownload | null = null
    let abortProbe: AbortProbe | null = null
    const activeManager = new ModelManager(join(tempRoot, 'active-models'))
    const downloadFile = vi
      .spyOn(testable(activeManager), 'downloadFile')
      .mockImplementation(async (_url, _dest, _expectedSize, _modelId, isAborted) => {
        abortProbe = isAborted
        await new Promise<void>((resolve) => {
          finishDownload = resolve
        })
      })
    vi.spyOn(testable(activeManager), 'verifyArchiveSha256').mockResolvedValue(undefined)
    vi.spyOn(testable(activeManager), 'extractArchive').mockResolvedValue(undefined)

    const download = activeManager.downloadModel(MODEL_ID)
    await vi.waitFor(async () => {
      await expect(activeManager.getModelState(MODEL_ID)).resolves.toMatchObject({
        status: 'downloading'
      })
    })

    await activeManager.downloadModel(MODEL_ID)
    expect(downloadFile).toHaveBeenCalledTimes(1)

    activeManager.cancelDownload(MODEL_ID)
    expect((abortProbe as unknown as AbortProbe)()).toBe(true)
    ;(finishDownload as unknown as FinishDownload)()
    await download

    await expect(activeManager.getModelState(MODEL_ID)).resolves.toEqual({
      id: MODEL_ID,
      status: 'not-downloaded'
    })
  })

  it('rejects unknown downloads and deletes', async () => {
    const manager = new ModelManager(join(tempRoot, 'models'))

    await expect(manager.downloadModel('missing-model')).rejects.toThrow(
      'Unknown model: missing-model'
    )
    await expect(manager.deleteModel('missing-model')).rejects.toThrow(
      'Unknown model: missing-model'
    )
  })
})
