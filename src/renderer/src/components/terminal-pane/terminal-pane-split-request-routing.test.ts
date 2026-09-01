// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SplitTerminalPaneDetail } from '@/constants/terminal'
import { BACKGROUND_WORKTREE_MEASURE_WINDOW_MS } from '../terminal/background-terminal-worktree-visibility'
import {
  _resetTerminalPaneSplitRequestRoutingForTests,
  cancelQueuedTerminalPaneSplitRequests,
  dispatchTerminalPaneSplitRequest,
  getTerminalPaneSplitMountLeaseTargets,
  hasTerminalPaneSplitMountLease,
  queueTerminalPaneSplitRequest,
  registerTerminalPaneSplitRequestHandler,
  resolveTerminalPaneSplitSourceId,
  takeQueuedTerminalPaneSplitRequests,
  TERMINAL_PANE_SPLIT_QUEUE_CAPACITY
} from './terminal-pane-split-request-routing'

const SOURCE_LEAF_ID = '11111111-1111-4111-8111-111111111111'

function splitRequest(tabId: string, paneRuntimeId = 9): SplitTerminalPaneDetail {
  return {
    tabId,
    paneRuntimeId,
    sourceLeafId: SOURCE_LEAF_ID,
    direction: 'vertical'
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  _resetTerminalPaneSplitRequestRoutingForTests()
})

afterEach(() => {
  _resetTerminalPaneSplitRequestRoutingForTests()
  vi.useRealTimers()
})

describe('parked terminal split request routing', () => {
  it('demonstrates that the legacy fire-and-forget event is lost before a parked pane mounts', () => {
    const handler = vi.fn()

    dispatchTerminalPaneSplitRequest(splitRequest('tab-parked'))
    const unregister = registerTerminalPaneSplitRequestHandler('tab-parked', undefined, handler)

    expect(handler).not.toHaveBeenCalled()
    unregister()
  })

  it('replays a parked-tab request after registrations for the mount settle', async () => {
    const request = splitRequest('tab-parked', 91)
    const splitPane = vi.fn()
    queueTerminalPaneSplitRequest(request)

    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(true)
    expect(splitPane).not.toHaveBeenCalled()

    const unregister = registerTerminalPaneSplitRequestHandler(
      'tab-parked',
      undefined,
      (detail) => {
        const sourcePaneId = resolveTerminalPaneSplitSourceId(detail, (leafId) =>
          leafId === SOURCE_LEAF_ID ? 7 : null
        )
        splitPane(sourcePaneId, detail.direction)
      }
    )
    await Promise.resolve()

    expect(splitPane).toHaveBeenCalledOnce()
    expect(splitPane).toHaveBeenCalledWith(7, 'vertical')
    expect(takeQueuedTerminalPaneSplitRequests('tab-parked')).toEqual([])
    // The stable leaf wins over the pre-park numeric pane id reminted by the mount.
    expect(splitPane).not.toHaveBeenCalledWith(91, expect.anything())
    unregister()
  })

  it('fails closed when a remount no longer contains the stable source leaf', () => {
    expect(resolveTerminalPaneSplitSourceId(splitRequest('tab-parked', 91), () => null)).toBe(-1)
  })

  it('keeps the mount lease through replay, then releases it at the existing measure bound', () => {
    queueTerminalPaneSplitRequest(splitRequest('tab-parked'))
    takeQueuedTerminalPaneSplitRequests('tab-parked')

    vi.advanceTimersByTime(BACKGROUND_WORKTREE_MEASURE_WINDOW_MS - 1)
    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(true)

    vi.advanceTimersByTime(1)
    expect(hasTerminalPaneSplitMountLease('tab-parked')).toBe(false)
  })

  it('cancels queued work and its mount lease when the target tab closes', () => {
    queueTerminalPaneSplitRequest(splitRequest('tab-closed'))

    cancelQueuedTerminalPaneSplitRequests('tab-closed')

    expect(takeQueuedTerminalPaneSplitRequests('tab-closed')).toEqual([])
    expect(hasTerminalPaneSplitMountLease('tab-closed')).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds both queued requests and leased target tabs', () => {
    for (let index = 0; index <= TERMINAL_PANE_SPLIT_QUEUE_CAPACITY; index += 1) {
      queueTerminalPaneSplitRequest(splitRequest(`tab-${index}`))
    }

    expect(takeQueuedTerminalPaneSplitRequests('tab-0')).toEqual([])
    expect(hasTerminalPaneSplitMountLease('tab-0')).toBe(false)
    expect(
      takeQueuedTerminalPaneSplitRequests(`tab-${TERMINAL_PANE_SPLIT_QUEUE_CAPACITY}`)
    ).toEqual([splitRequest(`tab-${TERMINAL_PANE_SPLIT_QUEUE_CAPACITY}`)])
    expect(vi.getTimerCount()).toBe(TERMINAL_PANE_SPLIT_QUEUE_CAPACITY)
  })

  it('replays same tab ids only to their owning worktree handlers', () => {
    queueTerminalPaneSplitRequest({ ...splitRequest('tab-shared'), worktreeId: 'repo::/one' })
    queueTerminalPaneSplitRequest({ ...splitRequest('tab-shared'), worktreeId: 'repo::/two' })
    const first = vi.fn()
    const second = vi.fn()

    const unregisterFirst = registerTerminalPaneSplitRequestHandler(
      'tab-shared',
      'repo::/one',
      first
    )
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: 'repo::/one' }))
    expect(second).not.toHaveBeenCalled()

    const unregisterSecond = registerTerminalPaneSplitRequestHandler(
      'tab-shared',
      'repo::/two',
      second
    )
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ worktreeId: 'repo::/two' }))
    expect(getTerminalPaneSplitMountLeaseTargets()).toEqual([
      { tabId: 'tab-shared', worktreeId: 'repo::/one' },
      { tabId: 'tab-shared', worktreeId: 'repo::/two' }
    ])
    unregisterFirst()
    unregisterSecond()
  })

  it('does not broadcast an unscoped live request to colliding worktree handlers', () => {
    const first = vi.fn()
    const second = vi.fn()
    const unregisterFirst = registerTerminalPaneSplitRequestHandler(
      'tab-shared',
      'repo::/one',
      first
    )
    const unregisterSecond = registerTerminalPaneSplitRequestHandler(
      'tab-shared',
      'repo::/two',
      second
    )

    dispatchTerminalPaneSplitRequest(splitRequest('tab-shared'))

    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    unregisterFirst()
    unregisterSecond()
  })

  it('does not let an unscoped handler consume a queued request with scoped collisions', () => {
    queueTerminalPaneSplitRequest({ ...splitRequest('tab-shared'), worktreeId: 'repo::/one' })
    queueTerminalPaneSplitRequest({ ...splitRequest('tab-shared'), worktreeId: 'repo::/two' })
    const handler = vi.fn()

    const unregister = registerTerminalPaneSplitRequestHandler('tab-shared', undefined, handler)

    expect(handler).not.toHaveBeenCalled()
    expect(takeQueuedTerminalPaneSplitRequests('tab-shared', 'repo::/one')).toHaveLength(1)
    unregister()
  })

  it('replays a withheld unscoped request when the collision becomes unambiguous', async () => {
    const first = vi.fn()
    const second = vi.fn()
    const unregisterFirst = registerTerminalPaneSplitRequestHandler(
      'tab-shared',
      'repo::/one',
      first
    )
    const unregisterSecond = registerTerminalPaneSplitRequestHandler(
      'tab-shared',
      'repo::/two',
      second
    )
    queueTerminalPaneSplitRequest(splitRequest('tab-shared'))

    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    unregisterFirst()
    await Promise.resolve()

    expect(second).toHaveBeenCalledOnce()
    unregisterSecond()
  })

  it('does not replay an unscoped request before colliding handlers finish registering', async () => {
    queueTerminalPaneSplitRequest(splitRequest('tab-shared'))
    const first = vi.fn()
    const second = vi.fn()

    const unregisterFirst = registerTerminalPaneSplitRequestHandler(
      'tab-shared',
      'repo::/one',
      first
    )
    const unregisterSecond = registerTerminalPaneSplitRequestHandler(
      'tab-shared',
      'repo::/two',
      second
    )
    await Promise.resolve()

    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
    unregisterFirst()
    unregisterSecond()
  })
})
