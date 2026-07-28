export const WORKSPACE_SPACE_MAX_SCANNED_ENTRIES = 100_000
export const WORKSPACE_SPACE_MAX_RETAINED_SCAN_BYTES = 64 * 1024 * 1024

const WORKSPACE_SPACE_ENTRY_OVERHEAD_BYTES = 512

export type WorkspaceSpaceScanLimits = {
  maxEntries: number
  maxRetainedBytes: number
}

/**
 * Tracks entries the traversal is holding right now, not entries it has ever
 * seen. Counters fall again as directory listings are dispatched and dropped,
 * so the caps bound live heap rather than total tree size.
 *
 * `maxEntries` bounds a single listing, because that is the only quantity fixed
 * by directory shape; the aggregate live cost is bounded by `maxRetainedBytes`.
 * A global entry cap would instead scale with worker concurrency, rejecting an
 * intact worktree purely because N workers happened to hold N listings at once.
 */
export type WorkspaceSpaceScanBudget = {
  entries: number
  retainedBytes: number
  limits: WorkspaceSpaceScanLimits
}

function formatLiveStateLimit(bytes: number): string {
  const mebibytes = bytes / (1024 * 1024)
  return mebibytes >= 1
    ? `${Math.round(mebibytes * 10) / 10} MiB`
    : `${bytes.toLocaleString('en-US')} bytes`
}

export class WorkspaceSpaceScanCapacityError extends Error {
  constructor(limits: WorkspaceSpaceScanLimits) {
    super(
      `Workspace is too large to scan safely (limit: ${limits.maxEntries.toLocaleString('en-US')} entries or ${formatLiveStateLimit(limits.maxRetainedBytes)} of live scan state)`
    )
    this.name = 'WorkspaceSpaceScanCapacityError'
  }
}

export function createWorkspaceSpaceScanBudget(
  requested?: Partial<WorkspaceSpaceScanLimits>
): WorkspaceSpaceScanBudget {
  return {
    entries: 0,
    retainedBytes: 0,
    limits: {
      maxEntries: clampLimit(requested?.maxEntries, WORKSPACE_SPACE_MAX_SCANNED_ENTRIES),
      maxRetainedBytes: clampLimit(
        requested?.maxRetainedBytes,
        WORKSPACE_SPACE_MAX_RETAINED_SCAN_BYTES
      )
    }
  }
}

export function estimateWorkspaceSpaceEntryRetainedBytes(entryName: string): number {
  return entryName.length * 2 + WORKSPACE_SPACE_ENTRY_OVERHEAD_BYTES
}

/**
 * Why: a listing's entries all share one parent-path string, so charging it per
 * entry inflated the estimate by the checkout depth. That made the byte cap
 * reject an intact worktree for living under a long path — the exact
 * path-dependence the resource-bounds doc says a live cap must not have.
 */
export function estimateWorkspaceSpaceListingRetainedBytes(parentPath: string): number {
  return parentPath.length * 2
}

export function retainWorkspaceSpaceScanEntry(
  budget: WorkspaceSpaceScanBudget,
  entryName: string,
  listingEntryCount: number,
  additionalBytes = 0
): void {
  const retainedBytes =
    budget.retainedBytes + estimateWorkspaceSpaceEntryRetainedBytes(entryName) + additionalBytes
  if (
    listingEntryCount >= budget.limits.maxEntries ||
    retainedBytes > budget.limits.maxRetainedBytes
  ) {
    throw new WorkspaceSpaceScanCapacityError(budget.limits)
  }
  budget.entries += 1
  budget.retainedBytes = retainedBytes
}

// Why: callers must return a listing's charge once they drop it, so the caps
// track live retention instead of accumulating across the whole traversal.
export function releaseWorkspaceSpaceScanEntries(
  budget: WorkspaceSpaceScanBudget,
  entryCount: number,
  retainedBytes: number
): void {
  budget.entries = Math.max(0, budget.entries - entryCount)
  budget.retainedBytes = Math.max(0, budget.retainedBytes - retainedBytes)
}

export type WorkspaceSpaceDirectoryAdmission<TEntry> = {
  entries: TEntry[]
  /** Charge held against the budget until the caller releases this listing. */
  retainedBytes: number
}

export async function collectWorkspaceSpaceDirectoryEntries<TEntry>(
  directory: AsyncIterable<TEntry> | Iterable<TEntry>,
  parentPath: string,
  entryName: (entry: TEntry) => string,
  budget: WorkspaceSpaceScanBudget,
  checkCancelled: () => void
): Promise<WorkspaceSpaceDirectoryAdmission<TEntry>> {
  const entries: TEntry[] = []
  let retainedBytes = 0
  try {
    for await (const entry of directory) {
      checkCancelled()
      const name = entryName(entry)
      // The listing's shared parent path is charged once, with its first entry,
      // so an empty listing holds no charge for the caller to release.
      const listingBytes =
        entries.length === 0 ? estimateWorkspaceSpaceListingRetainedBytes(parentPath) : 0
      retainWorkspaceSpaceScanEntry(budget, name, entries.length, listingBytes)
      retainedBytes += estimateWorkspaceSpaceEntryRetainedBytes(name) + listingBytes
      entries.push(entry)
    }
  } catch (error) {
    // Why: a rejected or cancelled listing is never handed to the caller, so
    // nothing would otherwise return the charge already taken for it.
    releaseWorkspaceSpaceScanEntries(budget, entries.length, retainedBytes)
    throw error
  }
  return { entries, retainedBytes }
}

function clampLimit(value: number | undefined, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    return maximum
  }
  return Math.min(value, maximum)
}
