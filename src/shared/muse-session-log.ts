import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readJsonlCursor, record, type JsonlCursor } from './codex-rollout-jsonl-cursor'

// Why: Muse stores sessions under <XDG_DATA_HOME>/muse/sessions (default
// ~/.local/share/muse/sessions), sharded by the host's local start date:
// <root>/YYYY/MM/DD/<uuid>/session.jsonl. No upstream override variable exists.
export function resolveMuseSessionsDir(override?: string): string {
  if (override?.trim()) {
    return override.trim()
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
  return join(dataHome, 'muse', 'sessions')
}

const UUID_V7 = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DAY_MS = 24 * 60 * 60 * 1000

function dayParts(date: Date, utc: boolean): string[] {
  const year = utc ? date.getUTCFullYear() : date.getFullYear()
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1
  const day = utc ? date.getUTCDate() : date.getDate()
  return [String(year), String(month).padStart(2, '0'), String(day).padStart(2, '0')]
}

/** Locates a live session's log from its UUIDv7 id, whose timestamp names the date shard. */
export function findMuseSessionLogPath(
  sessionId: string,
  sessionsDir = resolveMuseSessionsDir()
): string | undefined {
  const match = UUID_V7.exec(sessionId)
  if (!match) {
    return undefined
  }
  const startedAt = Number.parseInt(`${match[1]}${match[2]}`, 16)
  const candidates = new Set<string>()
  // Why: the shard uses Muse's local zone, which can differ from ours (relay, TZ env), so probe neighbors.
  for (const offset of [0, -DAY_MS, DAY_MS]) {
    const date = new Date(startedAt + offset)
    for (const utc of [false, true]) {
      candidates.add(join(sessionsDir, ...dayParts(date, utc), sessionId, 'session.jsonl'))
    }
  }
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return undefined
}

export type MuseUserInputQuestion = Record<string, unknown>

export type MusePendingUserInput = {
  promptId: string
  questions: MuseUserInputQuestion[]
}

export type MuseSessionLogState = {
  sessionId: string
  cursor: JsonlCursor
  pending: Map<string, MusePendingUserInput>
}

export function createMuseSessionLogState(sessionId: string): MuseSessionLogState {
  return { sessionId, cursor: { offset: 0, carry: '' }, pending: new Map() }
}

/** Advances the log and returns the newest unanswered `request_user_input` prompt, if any. */
export function readMusePendingUserInput(
  log: MuseSessionLogState,
  sessionsDir?: string
): MusePendingUserInput | undefined {
  log.cursor.filePath ??= findMuseSessionLogPath(log.sessionId, sessionsDir)
  for (const line of readJsonlCursor(log.cursor) ?? []) {
    const event = record(record(line.payload)?.event)
    const promptId = typeof event?.prompt_id === 'string' ? event.prompt_id : undefined
    if (!event || !promptId) {
      continue
    }
    if (event.kind === 'user_input_prompt_requested') {
      const questions = Array.isArray(event.questions)
        ? event.questions.flatMap((question: unknown) => {
            const entry = record(question)
            return entry ? [entry] : []
          })
        : []
      log.pending.delete(promptId)
      log.pending.set(promptId, { promptId, questions })
    } else if (event.kind === 'user_input_prompt_settled') {
      log.pending.delete(promptId)
    }
  }
  return Array.from(log.pending.values()).at(-1)
}
