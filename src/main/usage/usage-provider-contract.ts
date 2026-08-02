/**
 * Seam a usage source implements to be scanned by Orca, including plugin-contributed ones.
 *
 * Deliberately generic over each provider's record types: Claude bills per turn while
 * Codex/OpenCode bill per event, and `cachedInput` is a subset of `input` for the latter but a
 * peer bucket for Claude. A single normalized record would push nullable handling onto every
 * consumer, so only the scan envelope is shared.
 */

export type UsageProviderId = 'claude' | 'codex' | 'opencode' | `plugin:${string}`

export type UsageWorktreeRef = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

export type UsageScanResult<TSource, TSession, TDaily> = {
  /** Per-source scan cache. Providers persist this under their own field name. */
  processedSources: readonly TSource[]
  sessions: readonly TSession[]
  dailyAggregates: readonly TDaily[]
}

export type UsageProvider<TSource, TSession, TDaily> = {
  readonly id: UsageProviderId
  readonly label: string
  readonly schemaVersion: number
  scan(
    worktrees: readonly UsageWorktreeRef[],
    previous: readonly TSource[]
  ): Promise<UsageScanResult<TSource, TSession, TDaily>>
}
