import { yieldToEventLoop } from '../../shared/event-loop-yield'
import { devinSessionsIndexForSidecar } from '../devin/sessions-index'
import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'
import { sidecarUnchanged } from '../ai-vault/session-sidecar-stat'
import { createUsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import { resolveDevinTranscriptsDir } from '../devin/devin-cli-data-dir'
import { wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import {
  getProcessedFileInfo,
  listDevinTranscriptFiles,
  observeDevinSessionsDb
} from './devin-transcript-discovery'
import { parseDevinTranscriptForUsage } from './devin-transcript-parse'
import { attributeDevinUsageEvent } from './devin-usage-event-attribution'
import { devinUsageAggregation } from './devin-usage-aggregation'
import type { DevinUsageDailyAggregate, DevinUsagePersistedFile, DevinUsageSession } from './types'

export async function scanDevinUsageFiles(
  worktrees: UsageScanWorktreeRef[],
  previous: DevinUsagePersistedFile[] = [],
  onFilesScanned?: (count: number) => void
): Promise<{
  processedFiles: DevinUsagePersistedFile[]
  sessions: DevinUsageSession[]
  dailyAggregates: DevinUsageDailyAggregate[]
}> {
  const filePaths = await listDevinTranscriptFiles()
  const sessionsDb = await observeDevinSessionsDb(resolveDevinTranscriptsDir())
  const { index, unreadable } = devinSessionsIndexForSidecar(sessionsDb)
  if (unreadable) {
    throw new Error('Unable to read Devin session metadata; retry the scan')
  }
  const previousByPath = new Map(previous.map((file) => [file.path, file]))
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)
  const processedFiles: DevinUsagePersistedFile[] = []
  const ownerBySession = new Map<string, DevinUsagePersistedFile>()

  for (const [position, path] of filePaths.entries()) {
    try {
      const info = await getProcessedFileInfo(path)
      const cached = previousByPath.get(path)
      let file: DevinUsagePersistedFile
      if (
        cached &&
        typeof cached.sessionId === 'string' &&
        cached.mtimeMs === info.mtimeMs &&
        cached.size === info.size &&
        sidecarUnchanged(cached.sessionsDb, sessionsDb)
      ) {
        file = cached
      } else {
        const parsed = parseDevinTranscriptForUsage(
          path,
          await wslGatedReadFile(path, 'utf-8', 'scan'),
          index
        )
        if (!parsed) {
          continue
        }
        const events = parsed.hidden
          ? []
          : parsed.events
              .map((event) => attributeDevinUsageEvent(event, resolveWorktree))
              .filter((event) => event !== null)
        file = {
          ...info,
          sessionId: parsed.sessionId,
          sessionsDb,
          ...devinUsageAggregation.aggregate(events)
        }
      }
      processedFiles.push(file)
      // Cache every file's aggregates; choose one copy per session only when projecting.
      if (!ownerBySession.has(file.sessionId) || sessionIdFromFileName(path) === file.sessionId) {
        ownerBySession.set(file.sessionId, file)
      }
    } catch (error) {
      if (
        !(
          error &&
          typeof error === 'object' &&
          'code' in error &&
          (error.code === 'ENOENT' || error.code === 'ENOTDIR')
        )
      ) {
        throw error
      }
    } finally {
      onFilesScanned?.(1)
      if ((position + 1) % 10 === 0) {
        await yieldToEventLoop()
      }
    }
  }

  const sessions = new Map<string, DevinUsageSession>()
  const daily = new Map<string, DevinUsageDailyAggregate>()
  for (const file of ownerBySession.values()) {
    devinUsageAggregation.mergeSessions(sessions, file.sessions)
    devinUsageAggregation.mergeDailyAggregates(daily, file.dailyAggregates)
  }
  return {
    processedFiles,
    sessions: devinUsageAggregation.finalizeSessions(sessions),
    dailyAggregates: devinUsageAggregation.sortDailyAggregates(daily)
  }
}
