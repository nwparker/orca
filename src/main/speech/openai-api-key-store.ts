import { safeStorage } from 'electron'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hardenExistingSecureFile, writeSecureFile } from '../../shared/secure-file'

type StoredOpenAiKey = {
  encryptedKeyBase64: string
}

type OpenAiKeyEnvelope = {
  kind: 'encrypted' | 'plaintext'
  payload: Buffer
}

const OPENAI_SPEECH_TOKEN_FILE = 'openai-speech-token.enc'
const OPENAI_SPEECH_KEY_ENVELOPE_PREFIX = 'orca-openai-speech-key:v1:'
let cachedOpenAiSpeechApiKey: string | null = null
let warnedOpenAiKeyStatusHardenFailure = false

function getOrcaDir(): string {
  return join(homedir(), '.orca')
}

function getOpenAiKeyPath(): string {
  return join(getOrcaDir(), OPENAI_SPEECH_TOKEN_FILE)
}

function encodeOpenAiKeyEnvelope(kind: OpenAiKeyEnvelope['kind'], payload: Buffer): string {
  return `${OPENAI_SPEECH_KEY_ENVELOPE_PREFIX}${kind}:${payload.toString('base64')}`
}

function decodeOpenAiKeyEnvelope(raw: Buffer): OpenAiKeyEnvelope | null {
  const text = raw.toString('utf8')
  if (!text.startsWith(OPENAI_SPEECH_KEY_ENVELOPE_PREFIX)) {
    return null
  }
  const rest = text.slice(OPENAI_SPEECH_KEY_ENVELOPE_PREFIX.length)
  const separator = rest.indexOf(':')
  if (separator === -1) {
    throw new Error('OpenAI API key could not be decrypted')
  }
  const kind = rest.slice(0, separator)
  const encodedPayload = rest.slice(separator + 1)
  if (kind !== 'encrypted' && kind !== 'plaintext') {
    throw new Error('OpenAI API key could not be decrypted')
  }
  const payload = Buffer.from(encodedPayload, 'base64')
  if (!encodedPayload || !payload.length || payload.toString('base64') !== encodedPayload) {
    throw new Error('OpenAI API key could not be decrypted')
  }
  return { kind, payload }
}

function readLegacyJsonStoredOpenAiKey(raw: Buffer): StoredOpenAiKey | null {
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as Partial<StoredOpenAiKey>
    if (typeof parsed.encryptedKeyBase64 !== 'string' || parsed.encryptedKeyBase64 === '') {
      return null
    }
    return { encryptedKeyBase64: parsed.encryptedKeyBase64 }
  } catch {
    return null
  }
}

function decodeLegacyPlaintextKey(raw: Buffer): string {
  let plaintext: string
  try {
    plaintext = new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch {
    throw new Error('OpenAI API key could not be decrypted')
  }
  if (!plaintext || [...plaintext].some((char) => char.charCodeAt(0) < 32 || char === '\u007f')) {
    throw new Error('OpenAI API key could not be decrypted')
  }
  return plaintext
}

function readOpenAiKeyEnvelope(envelope: OpenAiKeyEnvelope): string {
  if (envelope.kind === 'plaintext') {
    return decodeLegacyPlaintextKey(envelope.payload)
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OpenAI API key could not be decrypted')
  }
  return safeStorage.decryptString(envelope.payload)
}

function readLegacyRawOpenAiKey(raw: Buffer): string {
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(raw)
    } catch {
      return decodeLegacyPlaintextKey(raw)
    }
  }
  return decodeLegacyPlaintextKey(raw)
}

export function hasOpenAiSpeechApiKey(): boolean {
  const keyPath = getOpenAiKeyPath()
  if (!existsSync(keyPath)) {
    return false
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    if (!warnedOpenAiKeyStatusHardenFailure) {
      warnedOpenAiKeyStatusHardenFailure = true
      console.warn('[speech] Failed to harden OpenAI speech key file while checking status', error)
    }
  }
  return true
}

export function saveOpenAiSpeechApiKey(apiKey: string): void {
  const trimmed = apiKey.trim()
  if (!trimmed) {
    throw new Error('OpenAI API key is required')
  }
  if (safeStorage.isEncryptionAvailable()) {
    writeSecureFile(
      getOpenAiKeyPath(),
      encodeOpenAiKeyEnvelope('encrypted', safeStorage.encryptString(trimmed))
    )
    cachedOpenAiSpeechApiKey = trimmed
    return
  }

  console.warn(
    '[speech] safeStorage encryption unavailable — storing OpenAI speech key in plaintext'
  )
  writeSecureFile(
    getOpenAiKeyPath(),
    encodeOpenAiKeyEnvelope('plaintext', Buffer.from(trimmed, 'utf8'))
  )
  cachedOpenAiSpeechApiKey = trimmed
}

export function readOpenAiSpeechApiKey(): string {
  if (cachedOpenAiSpeechApiKey !== null) {
    return cachedOpenAiSpeechApiKey
  }

  const keyPath = getOpenAiKeyPath()
  if (!existsSync(keyPath)) {
    throw new Error('OpenAI API key is not configured')
  }
  try {
    hardenExistingSecureFile(keyPath)
  } catch (error) {
    console.warn('[speech] Failed to harden OpenAI speech key file while reading', error)
  }
  try {
    const raw = readFileSync(keyPath)
    const envelope = decodeOpenAiKeyEnvelope(raw)
    if (envelope) {
      cachedOpenAiSpeechApiKey = readOpenAiKeyEnvelope(envelope)
      return cachedOpenAiSpeechApiKey
    }
    const legacyJson = readLegacyJsonStoredOpenAiKey(raw)
    if (legacyJson) {
      cachedOpenAiSpeechApiKey = safeStorage.decryptString(
        Buffer.from(legacyJson.encryptedKeyBase64, 'base64')
      )
      return cachedOpenAiSpeechApiKey
    }
    cachedOpenAiSpeechApiKey = readLegacyRawOpenAiKey(raw)
    return cachedOpenAiSpeechApiKey
  } catch {
    throw new Error('OpenAI API key could not be decrypted')
  }
}

export function clearOpenAiSpeechApiKey(): void {
  cachedOpenAiSpeechApiKey = null
  rmSync(getOpenAiKeyPath(), { force: true })
}
