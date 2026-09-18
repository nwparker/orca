import { z } from 'zod'

const count = z.number().finite().nonnegative()
const nullableText = z.string().nullable()
const tokens = {
  eventCount: count,
  inputTokens: count,
  cachedInputTokens: count,
  outputTokens: count,
  reasoningOutputTokens: count,
  totalTokens: count,
  estimatedCostUsd: count.nullable()
}
const location = z.object({
  ...tokens,
  locationKey: z.string(),
  projectLabel: z.string(),
  repoId: nullableText,
  worktreeId: nullableText
})
const model = z.object({ ...tokens, modelKey: z.string(), modelLabel: z.string() })
const locationModel = model.extend({
  locationKey: z.string(),
  repoId: nullableText,
  worktreeId: nullableText
})
const session = z.object({
  sessionId: z.string(),
  firstTimestamp: z.string(),
  lastTimestamp: z.string(),
  primaryModel: nullableText,
  hasMixedModels: z.boolean(),
  primaryProjectLabel: z.string(),
  hasMixedLocations: z.boolean(),
  primaryWorktreeId: nullableText,
  primaryRepoId: nullableText,
  eventCount: count,
  totalInputTokens: count,
  totalCachedInputTokens: count,
  totalOutputTokens: count,
  totalReasoningOutputTokens: count,
  totalTokens: count,
  estimatedCostUsd: count.nullable(),
  locationBreakdown: z.array(location),
  modelBreakdown: z.array(model),
  locationModelBreakdown: z.array(locationModel)
})
const daily = z.object({
  ...tokens,
  day: z.string(),
  model: nullableText,
  projectKey: z.string(),
  projectLabel: z.string(),
  repoId: nullableText,
  worktreeId: nullableText
})
const sidecar = z.union([
  z.literal('none'),
  z.literal('unknown'),
  z.object({ path: z.string(), mtimeMs: z.number().finite(), sizeBytes: count })
])
const file = z.object({
  path: z.string(),
  mtimeMs: z.number().finite(),
  size: count,
  sessionId: z.string(),
  sessionsDb: sidecar.optional(),
  sessions: z.array(session),
  dailyAggregates: z.array(daily)
})

export const devinUsagePersistedStateSchema = z.object({
  schemaVersion: z.number().int(),
  worktreeFingerprint: nullableText,
  processedFiles: z.array(file),
  sessions: z.array(session),
  dailyAggregates: z.array(daily),
  scanState: z.object({
    enabled: z.boolean(),
    lastScanStartedAt: count.nullable(),
    lastScanCompletedAt: count.nullable(),
    lastScanError: nullableText
  })
})
