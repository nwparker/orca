import {
  recordTerminalOutputQueueDebugPressure as recordQueueDebugPressure,
  terminalOutputSchedulerDebugEnabled as debugEnabled,
  terminalOutputSchedulerDebugState as debugState
} from './pane-terminal-output-scheduler-debug'
import { clearForegroundRelease, isEntryDrainable } from './pane-terminal-foreground-queue-state'
import { hasQueuedChunks } from './pane-terminal-output-queue-backlog'
import {
  BACKGROUND_DRAIN_INTERVAL_MS,
  DRAIN_TIME_BUDGET_MS,
  HIGH_PRIORITY_DRAIN_INTERVAL_MS,
  HIGH_PRIORITY_MAX_WRITES_PER_DRAIN,
  LARGE_BACKLOG_CHARS,
  MAX_WRITES_PER_DRAIN,
  isCooperativeQueueEntry,
  isCooperativeTurnPending,
  isHighPriorityQueueEntry,
  isMessageChannelDrainEnabled,
  markTerminalOutputDrainStarted,
  queuedByTerminal,
  resetCooperativeTurnPending,
  scheduleDrain,
  setCooperativeTurnPending,
  setTerminalOutputDrainRunner,
  type QueueEntry
} from './pane-terminal-output-queue-registry'

import { writeQueuedChunk } from './pane-terminal-output-pipeline'

// Why no per-write scroll enforcement: xterm's BufferService.isUserScrolling owns live follow/pin; app-side enforcement is limited to structural ops xterm can't identify, like replay.

function takeNextDrainableEntry(options?: { preferCooperative?: boolean }): QueueEntry | null {
  const preferCooperative = options?.preferCooperative === true
  let largeBacklogEntry: QueueEntry | null = null
  let visibleBackgroundEntry: QueueEntry | null = null
  let firstCooperativeEntry: QueueEntry | null = null
  let firstDrainableEntry: QueueEntry | null = null
  for (const entry of queuedByTerminal.values()) {
    if (!isEntryDrainable(entry)) {
      continue
    }
    firstDrainableEntry ??= entry
    if (isCooperativeQueueEntry(entry)) {
      firstCooperativeEntry ??= entry
    }
    // Why: active/foreground output should be chosen first, not left in insertion order behind older background terminals.
    if (entry.priority === 'high') {
      if (!preferCooperative) {
        queuedByTerminal.delete(entry.terminal)
        return entry
      }
      continue
    }
    if (!largeBacklogEntry && entry.queuedChars > LARGE_BACKLOG_CHARS) {
      largeBacklogEntry = entry
    }
    if (!visibleBackgroundEntry && entry.priority === 'visible-background') {
      visibleBackgroundEntry = entry
    }
  }
  const selected = preferCooperative
    ? visibleBackgroundEntry && isCooperativeQueueEntry(visibleBackgroundEntry)
      ? visibleBackgroundEntry
      : (firstCooperativeEntry ?? largeBacklogEntry ?? firstDrainableEntry)
    : (largeBacklogEntry ?? visibleBackgroundEntry ?? firstDrainableEntry)
  if (selected) {
    queuedByTerminal.delete(selected.terminal)
  }
  return selected
}

type QueueBacklogState = {
  hasDrainable: boolean
  hasHighPriority: boolean
  hasCooperative: boolean
  hasCompetingPriorities: boolean
}

function getQueueBacklogState(): QueueBacklogState {
  let hasDrainable = false
  let hasHighPriority = false
  let hasCooperative = false
  let highPriorityEntry: QueueEntry | null = null
  let cooperativeEntry: QueueEntry | null = null
  let hasCompetingPriorities = false
  for (const entry of queuedByTerminal.values()) {
    if (!isEntryDrainable(entry)) {
      continue
    }
    hasDrainable = true
    const cooperative = isCooperativeQueueEntry(entry)
    const highPriority = isHighPriorityQueueEntry(entry)
    if (cooperative) {
      hasCooperative = true
      cooperativeEntry ??= entry
      hasCompetingPriorities ||= highPriorityEntry !== null && highPriorityEntry !== entry
    }
    if (highPriority) {
      hasHighPriority = true
      highPriorityEntry ??= entry
      hasCompetingPriorities ||= cooperativeEntry !== null && cooperativeEntry !== entry
    }
    if (hasCompetingPriorities) {
      break
    }
  }
  return {
    hasDrainable,
    hasHighPriority,
    hasCooperative,
    hasCompetingPriorities
  }
}

// Why: re-arm a zero-delay drain once xterm confirms the previous high-priority batch parsed; the fixed 4/16ms cadence otherwise drips far below xterm's ~100 MB/s parse. Only visible panes are pacer-clocked; background keeps the fixed cadence to protect the focused terminal.

function getDrainNow(): number {
  if (typeof performance !== 'undefined') {
    return performance.now()
  }
  return Date.now()
}

export function drainQueuedOutputImpl(): void {
  markTerminalOutputDrainStarted()
  let writes = 0
  const startedAt = getDrainNow()
  const requestedCooperativeTurn = isCooperativeTurnPending()
  let entry = takeNextDrainableEntry({ preferCooperative: requestedCooperativeTurn })
  const cooperativeTurn =
    requestedCooperativeTurn && entry !== null && isCooperativeQueueEntry(entry)
  const highPriority = !cooperativeTurn && entry !== null && isHighPriorityQueueEntry(entry)
  // A fairness turn is intentionally one write: keep active output's first
  // paint budget intact while giving another pane a bounded chance to parse.
  const maxWrites = cooperativeTurn
    ? 1
    : highPriority
      ? HIGH_PRIORITY_MAX_WRITES_PER_DRAIN
      : MAX_WRITES_PER_DRAIN

  while (entry !== null && writes < maxWrites) {
    const writeKind = writeQueuedChunk(entry)
    if (writeKind) {
      writes++
      if (debugEnabled) {
        if (writeKind === 'foreground') {
          debugState.deferredForegroundWriteCount++
        } else {
          debugState.backgroundWriteCount++
        }
      }
    }
    if (hasQueuedChunks(entry)) {
      queuedByTerminal.set(entry.terminal, entry)
    } else {
      entry.priority = 'background'
      clearForegroundRelease(entry)
    }
    // Why: xterm parsing and DOM work share the renderer thread with input; keep draining cooperative so WSL/agent output can't pin the UI.
    if (writes > 0 && getDrainNow() - startedAt >= DRAIN_TIME_BUDGET_MS) {
      break
    }
    if (writes >= maxWrites) {
      break
    }
    const nextEntry = takeNextDrainableEntry()
    if (
      highPriority &&
      nextEntry?.priority === 'visible-background' &&
      !isHighPriorityQueueEntry(nextEntry) &&
      nextEntry !== entry
    ) {
      // A high-priority tick must not pull cooperative visible redraws into
      // the same batch; leave them for the next frame-sized drain.
      queuedByTerminal.set(nextEntry.terminal, nextEntry)
      break
    }
    entry = nextEntry
  }

  if (debugEnabled && writes > 0) {
    debugState.drainWrites.push(writes)
    debugState.drainHighPriority.push(highPriority)
  }
  recordQueueDebugPressure()
  if (queuedByTerminal.size === 0) {
    resetCooperativeTurnPending()
    return
  }
  const backlogState = getQueueBacklogState()
  if (cooperativeTurn) {
    resetCooperativeTurnPending()
  } else if (highPriority && backlogState.hasCompetingPriorities) {
    // Alternate one high-priority burst with one cooperative write. This is
    // only armed when a lower-priority queue is actually waiting.
    setCooperativeTurnPending(true)
  } else if (!backlogState.hasHighPriority || !backlogState.hasCooperative) {
    resetCooperativeTurnPending()
  }
  if (backlogState.hasDrainable) {
    // Why 0 on the channel path: a posted message already yields (input/paint serviced between macrotasks), so the 4ms interval only deepened the queue; timer path keeps it for fake-timer tests.
    scheduleDrain(
      backlogState.hasHighPriority
        ? isMessageChannelDrainEnabled()
          ? 0
          : HIGH_PRIORITY_DRAIN_INTERVAL_MS
        : BACKGROUND_DRAIN_INTERVAL_MS
    )
  }
}

// Why at module scope: the registry's scheduleDrain must never fire before a runner exists, so registration happens as this module is evaluated rather than on first use.
setTerminalOutputDrainRunner(drainQueuedOutputImpl)
