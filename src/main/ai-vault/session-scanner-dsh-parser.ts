import type { AiVaultSession } from '../../shared/ai-vault-types'
import type {
  FileWithMtime,
  SessionAccumulator,
  ResumableParseFinalizeOptions
} from './session-scanner-types'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import {
  addPreviewContent,
  createAccumulator,
  finalizeSession,
  updateTimeline
} from './session-scanner-accumulator'
import {
  asRecord,
  extractString,
  normalizeTitleText,
  numberValue,
  parseJsonObject
} from './session-scanner-values'
import { dshGenerationVersion } from './session-scanner-dsh-generations'
import { dshTranscriptLines, localDshTranscriptBytes } from './session-scanner-dsh-stream'

// Physical schemas: official Harness 639ed015, session-format-v0-to-v1 through v3-to-v4.
export async function parseDshSessionBytes(
  file: FileWithMtime,
  bytes: AsyncIterable<Buffer>,
  platform: NodeJS.Platform,
  options: ResumableParseFinalizeOptions = {},
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  const accumulator = createAccumulator({ agent: 'dsh', file, sessionId: '', messages })
  let header = false
  let inherited = false
  let seedLength = 0
  let sequence = 0
  for await (const line of dshTranscriptLines(file.path, bytes, signal)) {
    const record = parseJsonObject(line)
    if (!record) {
      throw new Error('Malformed DSH history record')
    }
    if (!header) {
      const version = record.version
      if (typeof version !== 'number' || version < 0 || version > 4 || !Number.isInteger(version)) {
        throw new Error('Unsupported DSH history format; update the transcript-owning Orca host')
      }
      if (
        record.type !== 'session' ||
        version !== dshGenerationVersion(file.path) ||
        !extractString(record.id)
      ) {
        throw new Error('DSH history header does not match its generation')
      }
      if (
        typeof record.createdAt !== 'number' ||
        !Number.isSafeInteger(record.createdAt) ||
        record.createdAt < 0 ||
        typeof record.delegationDepth !== 'number' ||
        !Number.isSafeInteger(record.delegationDepth) ||
        record.delegationDepth < 0 ||
        (version >= 2 && typeof record.isSeeded !== 'boolean') ||
        (record.seedLength !== undefined &&
          (typeof record.seedLength !== 'number' ||
            !Number.isSafeInteger(record.seedLength) ||
            record.seedLength < 0))
      ) {
        throw new Error('Malformed DSH history ownership/seed header')
      }
      if (record.origin === 'subagent' || numberValue(record.delegationDepth) > 0) {
        return null
      }
      accumulator.sessionId = extractString(record.id) ?? ''
      accumulator.cwd = extractString(record.cwd)
      updateTimeline(accumulator, record.createdAt)
      inherited = version >= 2 && record.isSeeded === true
      seedLength = version < 2 ? numberValue(record.seedLength) : 0
      header = true
      continue
    }
    // Old packed deltas occupy several sequence slots but are not settled messages.
    const packed = typeof record.seq0 === 'number' && asRecord(record.data)
    if (packed) {
      const data = asRecord(record.data)
      const chunks = data?.texts ?? data?.args
      if (record.seq0 !== sequence || !Array.isArray(chunks)) {
        throw new Error('DSH history sequence gap')
      }
      sequence += chunks.length
      continue
    }
    if (record.seq !== sequence++) {
      throw new Error('DSH history sequence gap')
    }
    const data = asRecord(record.data)
    if (!data) {
      throw new Error('Malformed DSH history event data')
    }
    updateTimeline(accumulator, record.time)
    if (record.type === 'session/end-seed' && data.inherited === true) {
      inherited = false
      continue
    }
    if (inherited || numberValue(record.seq) < seedLength) {
      continue
    }
    foldDshEvent(accumulator, record, data)
  }
  if (seedLength > sequence) {
    throw new Error('DSH legacy inherited seed exceeds its event count')
  }
  if (inherited) {
    throw new Error('DSH seeded history is missing its inherited boundary')
  }
  return header ? finalizeSession(accumulator, platform, options) : null
}

function foldDshEvent(
  accumulator: SessionAccumulator,
  record: Record<string, unknown>,
  data: Record<string, unknown>
): void {
  if (record.type === 'session/title') {
    accumulator.title = normalizeTitleText(extractString(data.title) ?? '') ?? accumulator.title
  }
  if (record.type === 'request/header') {
    const model = asRecord(data.header)
    accumulator.model ??=
      extractString(asRecord(model?.config)?.model) ?? extractString(model?.model)
  }
  const message = record.type === 'user/message' ? data : asRecord(data.message)
  const source = asRecord(message?.source)
  if (record.type === 'user/message' && source?.kind !== 'user') {
    return
  }
  const role =
    record.type === 'user/message'
      ? 'user'
      : record.type === 'assistant/message'
        ? 'assistant'
        : record.type === 'tool/result'
          ? 'tool'
          : null
  if (!role || !message || message.role !== role) {
    return
  }
  if (role !== 'tool') {
    accumulator.messageCount++
  }
  addPreviewContent(accumulator, role, message.content, record.time)
  if (role === 'user') {
    accumulator.title ??= normalizeTitleText(
      extractString(asRecord(Array.isArray(message.content) ? message.content[0] : null)?.text) ??
        ''
    )
  }
  if (role === 'assistant') {
    accumulator.model ??= extractString(source?.model)
    const usage = asRecord(data.usage)
    accumulator.totalTokens +=
      numberValue(usage?.totalTokens) ||
      numberValue(usage?.inputTokens) +
        numberValue(usage?.outputTokens) +
        numberValue(usage?.cacheReadTokens) +
        numberValue(usage?.cacheWriteTokens)
  }
}

export function parseDshSessionFile(
  file: FileWithMtime,
  platform: NodeJS.Platform,
  messages?: TranscriptMessageSink,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  return parseDshSessionBytes(
    file,
    localDshTranscriptBytes(file.path),
    platform,
    {},
    messages,
    signal
  )
}
