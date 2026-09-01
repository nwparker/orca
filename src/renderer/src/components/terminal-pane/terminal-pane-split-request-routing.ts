import { SPLIT_TERMINAL_PANE_EVENT, type SplitTerminalPaneDetail } from '@/constants/terminal'
import { BACKGROUND_WORKTREE_MEASURE_WINDOW_MS } from '../terminal/background-terminal-worktree-visibility'

// Why 32: ordinary use has one request; the cap tolerates automation bursts without letting a stalled renderer retain unbounded commands or mount leases.
export const TERMINAL_PANE_SPLIT_QUEUE_CAPACITY = 32

type SplitMountLease = {
  timer: ReturnType<typeof setTimeout>
  token: symbol
  tabId: string
  worktreeId?: string
}

export type TerminalPaneSplitMountLeaseTarget = {
  tabId: string
  worktreeId?: string
}

const queuedRequests: SplitTerminalPaneDetail[] = []
const splitMountLeasesByTarget = new Map<string, SplitMountLease>()
const splitMountLeaseListeners = new Set<() => void>()
type SplitRequestHandlerRegistration = {
  worktreeId: string | undefined
  handler: (detail: SplitTerminalPaneDetail) => void
}
const splitRequestHandlersByTab = new Map<string, Set<SplitRequestHandlerRegistration>>()
const pendingLegacyQueueFlushTabIds = new Set<string>()
let splitMountLeaseTargets: readonly TerminalPaneSplitMountLeaseTarget[] = []
let routingGeneration = 0

function notifySplitMountLeaseChange(): void {
  const leases = [...splitMountLeasesByTarget.values()]
  splitMountLeaseTargets = leases.map(({ tabId, worktreeId }) => ({
    tabId,
    ...(worktreeId !== undefined ? { worktreeId } : {})
  }))
  for (const listener of splitMountLeaseListeners) {
    listener()
  }
}

function splitTargetKey(tabId: string, worktreeId: string | undefined): string {
  return `${worktreeId ?? ''}\0${tabId}`
}

function removeQueuedRequestsForTarget(tabId: string, worktreeId?: string): void {
  for (let index = queuedRequests.length - 1; index >= 0; index -= 1) {
    const request = queuedRequests[index]
    if (
      request.tabId === tabId &&
      (worktreeId === undefined || request.worktreeId === worktreeId)
    ) {
      queuedRequests.splice(index, 1)
    }
  }
}

function releaseSplitMountLease(tabId: string, worktreeId?: string, token?: symbol): void {
  let changed = false
  for (const [key, lease] of splitMountLeasesByTarget) {
    if (
      lease.tabId !== tabId ||
      (worktreeId !== undefined && lease.worktreeId !== worktreeId) ||
      (token !== undefined && lease.token !== token)
    ) {
      continue
    }
    clearTimeout(lease.timer)
    splitMountLeasesByTarget.delete(key)
    changed = true
  }
  if (changed) {
    notifySplitMountLeaseChange()
  }
}

function evictOldestSplitMountLease(): void {
  const oldest = splitMountLeasesByTarget.values().next().value as SplitMountLease | undefined
  if (!oldest) {
    return
  }
  removeQueuedRequestsForTarget(oldest.tabId, oldest.worktreeId)
  releaseSplitMountLease(oldest.tabId, oldest.worktreeId)
}

function acquireSplitMountLease(tabId: string, worktreeId?: string): void {
  const key = splitTargetKey(tabId, worktreeId)
  const existing = splitMountLeasesByTarget.get(key)
  if (existing) {
    clearTimeout(existing.timer)
    splitMountLeasesByTarget.delete(key)
  } else if (splitMountLeasesByTarget.size >= TERMINAL_PANE_SPLIT_QUEUE_CAPACITY) {
    evictOldestSplitMountLease()
  }

  const token = Symbol(tabId)
  const timer = setTimeout(() => {
    removeQueuedRequestsForTarget(tabId, worktreeId)
    releaseSplitMountLease(tabId, worktreeId, token)
  }, BACKGROUND_WORKTREE_MEASURE_WINDOW_MS)
  splitMountLeasesByTarget.set(key, { timer, token, tabId, worktreeId })
  if (!existing) {
    notifySplitMountLeaseChange()
  }
}

/** Keeps a parked tab mountable for the same bounded lease used by background terminal mounts. */
export function queueTerminalPaneSplitRequest(detail: SplitTerminalPaneDetail): void {
  if (!detail.tabId) {
    return
  }
  while (queuedRequests.length >= TERMINAL_PANE_SPLIT_QUEUE_CAPACITY) {
    queuedRequests.shift()
  }
  queuedRequests.push(detail)
  acquireSplitMountLease(detail.tabId, detail.worktreeId)
}

function takeQueuedSplitRequests(
  tabId: string,
  worktreeId: string | undefined,
  scope: 'all' | 'scoped' | 'unscoped'
): SplitTerminalPaneDetail[] {
  const requests: SplitTerminalPaneDetail[] = []
  const registeredHandlers = splitRequestHandlersByTab.get(tabId)
  const unscopedRouteIsUnambiguous =
    registeredHandlers === undefined || registeredHandlers.size === 1
  for (let index = queuedRequests.length - 1; index >= 0; index -= 1) {
    const request = queuedRequests[index]
    if (
      request.tabId !== tabId ||
      (scope === 'scoped' && request.worktreeId === undefined) ||
      (scope === 'unscoped' && request.worktreeId !== undefined) ||
      (request.worktreeId === undefined && !unscopedRouteIsUnambiguous) ||
      (worktreeId === undefined && request.worktreeId !== undefined) ||
      (worktreeId !== undefined &&
        request.worktreeId !== undefined &&
        request.worktreeId !== worktreeId)
    ) {
      continue
    }
    requests.unshift(request)
    queuedRequests.splice(index, 1)
  }
  return requests
}

export function takeQueuedTerminalPaneSplitRequests(
  tabId: string,
  worktreeId?: string
): SplitTerminalPaneDetail[] {
  return takeQueuedSplitRequests(tabId, worktreeId, 'all')
}

function scheduleLegacyQueuedRequestFlush(tabId: string): void {
  if (
    pendingLegacyQueueFlushTabIds.has(tabId) ||
    !queuedRequests.some((request) => request.tabId === tabId && request.worktreeId === undefined)
  ) {
    return
  }
  pendingLegacyQueueFlushTabIds.add(tabId)
  const generation = routingGeneration
  queueMicrotask(() => {
    if (generation !== routingGeneration) {
      return
    }
    pendingLegacyQueueFlushTabIds.delete(tabId)
    const registrations = splitRequestHandlersByTab.get(tabId)
    if (registrations?.size !== 1) {
      return
    }
    const registration = registrations.values().next().value as
      | SplitRequestHandlerRegistration
      | undefined
    if (!registration) {
      return
    }
    for (const detail of takeQueuedSplitRequests(tabId, registration.worktreeId, 'unscoped')) {
      registration.handler(detail)
    }
  })
}

export function cancelQueuedTerminalPaneSplitRequests(tabId: string, worktreeId?: string): void {
  removeQueuedRequestsForTarget(tabId, worktreeId)
  releaseSplitMountLease(tabId, worktreeId)
}

export function hasTerminalPaneSplitMountLease(tabId: string, worktreeId?: string): boolean {
  return [...splitMountLeasesByTarget.values()].some(
    (lease) =>
      lease.tabId === tabId && (worktreeId === undefined || lease.worktreeId === worktreeId)
  )
}

export function subscribeTerminalPaneSplitMountLeases(listener: () => void): () => void {
  splitMountLeaseListeners.add(listener)
  return () => splitMountLeaseListeners.delete(listener)
}

/** Stable lease targets retain worktree identity for per-worktree parking decisions. */
export function getTerminalPaneSplitMountLeaseTargets(): readonly TerminalPaneSplitMountLeaseTarget[] {
  return splitMountLeaseTargets
}

export function dispatchTerminalPaneSplitRequest(detail: SplitTerminalPaneDetail): void {
  window.dispatchEvent(
    new CustomEvent<SplitTerminalPaneDetail>(SPLIT_TERMINAL_PANE_EVENT, { detail })
  )
}

export function registerTerminalPaneSplitRequestHandler(
  tabId: string,
  worktreeId: string | undefined,
  handler: (detail: SplitTerminalPaneDetail) => void
): () => void {
  const registration: SplitRequestHandlerRegistration = { worktreeId, handler }
  const registrations = splitRequestHandlersByTab.get(tabId) ?? new Set()
  registrations.add(registration)
  splitRequestHandlersByTab.set(tabId, registrations)
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<SplitTerminalPaneDetail>).detail
    if (detail?.tabId !== tabId) {
      return
    }
    if (detail.worktreeId === undefined) {
      // Legacy requests omit worktree identity; once duplicate tabs are mounted, broadcasting
      // would split whichever copy happened to register first (or all copies at once).
      if (registrations.size === 1) {
        handler(detail)
      }
      return
    }
    if (detail.worktreeId === worktreeId) {
      handler(detail)
    }
  }
  window.addEventListener(SPLIT_TERMINAL_PANE_EVENT, listener)
  for (const detail of takeQueuedSplitRequests(tabId, worktreeId, 'scoped')) {
    handler(detail)
  }
  scheduleLegacyQueuedRequestFlush(tabId)
  return () => {
    window.removeEventListener(SPLIT_TERMINAL_PANE_EVENT, listener)
    registrations.delete(registration)
    if (registrations.size === 0) {
      splitRequestHandlersByTab.delete(tabId)
      return
    }
    if (registrations.size === 1) {
      scheduleLegacyQueuedRequestFlush(tabId)
    }
  }
}

export function resolveTerminalPaneSplitSourceId(
  detail: SplitTerminalPaneDetail,
  getNumericIdForLeaf: (leafId: string) => number | null
): number {
  return detail.sourceLeafId
    ? (getNumericIdForLeaf(detail.sourceLeafId) ?? -1)
    : detail.paneRuntimeId
}

export function _resetTerminalPaneSplitRequestRoutingForTests(): void {
  routingGeneration += 1
  queuedRequests.splice(0)
  for (const lease of splitMountLeasesByTarget.values()) {
    clearTimeout(lease.timer)
  }
  splitMountLeasesByTarget.clear()
  splitMountLeaseListeners.clear()
  splitRequestHandlersByTab.clear()
  pendingLegacyQueueFlushTabIds.clear()
  splitMountLeaseTargets = []
}
