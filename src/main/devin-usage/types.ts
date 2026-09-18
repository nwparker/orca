import type {
  UsageDailyAggregate,
  UsageLocationBreakdown,
  UsageLocationModelBreakdown,
  UsageModelBreakdown,
  UsageSession
} from '../usage/usage-rollup-records'
import type { SessionSidecarObservation } from '../ai-vault/session-sidecar-stat'

export type DevinUsageMetric = { estimatedCostUsd: number | null }

export type DevinUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
}

export type DevinUsageSession = UsageSession<DevinUsageMetric>
export type DevinUsageDailyAggregate = UsageDailyAggregate<DevinUsageMetric>
export type DevinUsageLocationBreakdown = UsageLocationBreakdown<DevinUsageMetric>
export type DevinUsageModelBreakdown = UsageModelBreakdown<DevinUsageMetric>
export type DevinUsageLocationModelBreakdown = UsageLocationModelBreakdown<DevinUsageMetric>

export type DevinUsagePersistedFile = DevinUsageProcessedFile & {
  sessionsDb?: SessionSidecarObservation
  sessionId: string
  sessions: DevinUsageSession[]
  dailyAggregates: DevinUsageDailyAggregate[]
}

export type DevinUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedFiles: DevinUsagePersistedFile[]
  sessions: DevinUsageSession[]
  dailyAggregates: DevinUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type DevinUsageParsedEvent = {
  sessionId: string
  timestamp: string
  model: string | null
  cwd: string | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
}

export type DevinUsageAttributedEvent = DevinUsageParsedEvent & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
