import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import type * as Os from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const safeStorageMock = vi.hoisted(() => ({
  decryptString: vi.fn((value: Buffer) => {
    if (value[0] !== 0 || value[1] !== 0xff || value[2] !== 0x13) {
      throw new Error('not safeStorage ciphertext')
    }
    return value.subarray(3).toString('utf8')
  }),
  encryptString: vi.fn((value: string) => encryptedPayload(value)),
  isEncryptionAvailable: vi.fn(() => true)
}))

let tempHome = ''

async function loadStoreModule() {
  vi.resetModules()
  vi.doMock('electron', () => ({
    safeStorage: safeStorageMock
  }))
  vi.doMock('os', async () => {
    const actual = await vi.importActual<typeof Os>('os')
    return { ...actual, homedir: () => tempHome }
  })
  return import('./openai-api-key-store')
}

beforeEach(() => {
  tempHome = mkdtempLike('orca-openai-key-store-')
  safeStorageMock.decryptString.mockClear()
  safeStorageMock.encryptString.mockClear()
  safeStorageMock.isEncryptionAvailable.mockClear()
  safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
})

function mkdtempLike(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

function encryptedPayload(value: string): Buffer {
  return Buffer.concat([Buffer.from([0, 0xff, 0x13]), Buffer.from(value)])
}

function openAiKeyPath(): string {
  return join(tempHome, '.orca', 'openai-speech-token.enc')
}

function writeStoredOpenAiKey(value: string | Buffer): void {
  const orcaDir = join(tempHome, '.orca')
  mkdirSync(orcaDir, { recursive: true })
  writeFileSync(openAiKeyPath(), value)
}

describe('OpenAI speech API key store', () => {
  it('checks configured status without decrypting or touching safeStorage', async () => {
    writeStoredOpenAiKey(encryptedPayload('encrypted-key'))
    const store = await loadStoreModule()

    expect(store.hasOpenAiSpeechApiKey()).toBe(true)
    expect(safeStorageMock.isEncryptionAvailable).not.toHaveBeenCalled()
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })

  it('decrypts only when the key is read for an API request', async () => {
    const encrypted = encryptedPayload('encrypted-key')
    writeStoredOpenAiKey(encrypted)
    const store = await loadStoreModule()

    expect(store.readOpenAiSpeechApiKey()).toBe('encrypted-key')
    expect(safeStorageMock.decryptString).toHaveBeenCalledOnce()
    expect(safeStorageMock.decryptString).toHaveBeenCalledWith(encrypted)
  })

  it('caches the decrypted key so repeated dictations do not repeatedly touch safeStorage', async () => {
    writeStoredOpenAiKey(encryptedPayload('encrypted-key'))
    const store = await loadStoreModule()

    expect(store.readOpenAiSpeechApiKey()).toBe('encrypted-key')
    expect(store.readOpenAiSpeechApiKey()).toBe('encrypted-key')
    expect(safeStorageMock.decryptString).toHaveBeenCalledOnce()
  })

  it('uses the in-memory key after save without decrypting from safeStorage', async () => {
    const store = await loadStoreModule()

    store.saveOpenAiSpeechApiKey('saved-key')

    expect(store.readOpenAiSpeechApiKey()).toBe('saved-key')
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
    expect(readFileSync(openAiKeyPath(), 'utf8')).toMatch(/^orca-openai-speech-key:v1:encrypted:/)
  })

  it('reads enveloped plaintext after safeStorage becomes available', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const unavailableStore = await loadStoreModule()
    unavailableStore.saveOpenAiSpeechApiKey('plaintext-key')

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    safeStorageMock.decryptString.mockClear()
    const availableStore = await loadStoreModule()

    expect(availableStore.readOpenAiSpeechApiKey()).toBe('plaintext-key')
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('fails closed for enveloped ciphertext until safeStorage returns', async () => {
    const availableStore = await loadStoreModule()
    availableStore.saveOpenAiSpeechApiKey('encrypted-key')

    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const unavailableStore = await loadStoreModule()
    expect(() => unavailableStore.readOpenAiSpeechApiKey()).toThrow(/could not be decrypted/)

    safeStorageMock.isEncryptionAvailable.mockReturnValue(true)
    const recoveredStore = await loadStoreModule()
    expect(recoveredStore.readOpenAiSpeechApiKey()).toBe('encrypted-key')
  })

  it('rejects malformed envelope payloads', async () => {
    writeStoredOpenAiKey('orca-openai-speech-key:v1:plaintext:not-base64!')
    const store = await loadStoreModule()

    expect(() => store.readOpenAiSpeechApiKey()).toThrow(/could not be decrypted/)
  })

  it('migrates legacy plaintext when safeStorage decryption rejects it', async () => {
    writeStoredOpenAiKey('legacy-plaintext-key')
    const store = await loadStoreModule()

    expect(store.readOpenAiSpeechApiKey()).toBe('legacy-plaintext-key')
  })

  it('reads the legacy JSON encrypted-key format', async () => {
    const encrypted = encryptedPayload('legacy-json-key')
    writeStoredOpenAiKey(JSON.stringify({ encryptedKeyBase64: encrypted.toString('base64') }))
    const store = await loadStoreModule()

    expect(store.readOpenAiSpeechApiKey()).toBe('legacy-json-key')
  })

  it('does not decode legacy ciphertext as plaintext while safeStorage is unavailable', async () => {
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    writeStoredOpenAiKey(encryptedPayload('encrypted-key'))
    const store = await loadStoreModule()

    expect(() => store.readOpenAiSpeechApiKey()).toThrow(/could not be decrypted/)
  })

  it.runIf(process.platform !== 'win32')(
    'restricts an existing credential file when saving',
    async () => {
      writeStoredOpenAiKey('old-key')
      chmodSync(openAiKeyPath(), 0o644)
      const store = await loadStoreModule()

      store.saveOpenAiSpeechApiKey('new-key')

      expect(statSync(openAiKeyPath()).mode & 0o777).toBe(0o600)
    }
  )

  it('writes plaintext in a versioned envelope when encryption is unavailable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    safeStorageMock.isEncryptionAvailable.mockReturnValue(false)
    const store = await loadStoreModule()

    store.saveOpenAiSpeechApiKey('plaintext-key')

    expect(readFileSync(openAiKeyPath(), 'utf8')).toMatch(/^orca-openai-speech-key:v1:plaintext:/)
    warn.mockRestore()
  })

  it('reports missing status without creating storage files', async () => {
    const store = await loadStoreModule()

    expect(store.hasOpenAiSpeechApiKey()).toBe(false)
    expect(existsSync(join(tempHome, '.orca'))).toBe(false)
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()
  })
})
