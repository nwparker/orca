import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Notifications from 'expo-notifications'
import { subscribeToDesktopNotifications } from './mobile-notifications'
import { resetHostNotificationSessionsForTests } from './notification-reconnect-catchup'
import type { RpcClient } from '../transport/rpc-client'
import { loadPushNotificationsEnabled } from '../storage/preferences'

vi.mock('expo-notifications', () => ({
  AndroidImportance: { HIGH: 'high' },
  setNotificationChannelAsync: vi.fn(),
  getPermissionsAsync: vi.fn(),
  requestPermissionsAsync: vi.fn(),
  scheduleNotificationAsync: vi.fn(),
  dismissNotificationAsync: vi.fn()
}))

vi.mock('react-native', () => ({
  Platform: { OS: 'ios', Version: 18 }
}))

const WATERMARK_KEY = 'orca:mobileNotificationsWatermark:host-1'
const storage = new Map<string, string>()

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      storage.set(key, value)
    })
  }
}))

vi.mock('../storage/preferences', () => ({
  loadPushNotificationsEnabled: vi.fn()
}))

function flushAsync(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 10)
  })
}

function persistedSeq(): number {
  return (JSON.parse(storage.get(WATERMARK_KEY) ?? '{}') as { seq?: number }).seq ?? 0
}

type MissedOutcome =
  | { kind: 'reject' }
  | { kind: 'notOk' }
  | { kind: 'ok'; notifications: unknown[] }

function makeHostClient() {
  let onData: ((data: unknown) => void) | null = null
  const askedFrom: number[] = []
  let outcome: MissedOutcome = { kind: 'ok', notifications: [] }
  const client = {
    subscribe: vi.fn((_m: string, _p: unknown, cb: (data: unknown) => void) => {
      onData = cb
      return vi.fn(() => {
        onData = null
      })
    }),
    getState: vi.fn(() => 'connected'),
    sendRequest: vi.fn(async (method: string, params: unknown = {}) => {
      if (method !== 'notifications.getMissedSince') {
        return { ok: true, result: undefined } as never
      }
      askedFrom.push((params as { lastSeenSeq: number }).lastSeenSeq)
      if (outcome.kind === 'reject') {
        throw new Error('socket closed')
      }
      if (outcome.kind === 'notOk') {
        return { ok: false, error: { message: 'timeout' } } as never
      }
      return { ok: true, result: { notifications: outcome.notifications } } as never
    })
  }
  return {
    client: client as unknown as RpcClient,
    get onData() {
      return onData
    },
    askedFrom,
    setOutcome(next: MissedOutcome) {
      outcome = next
    }
  }
}

function notification(seq: number) {
  return {
    type: 'notification',
    title: `m${seq}`,
    body: 'b',
    notificationId: `agent:${seq}`,
    notificationSeq: seq
  }
}

describe('#8591 catch-up failure quarantines the watermark', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storage.clear()
    resetHostNotificationSessionsForTests()
    vi.mocked(loadPushNotificationsEnabled).mockResolvedValue(true)
    vi.mocked(Notifications.getPermissionsAsync).mockResolvedValue({
      status: 'granted',
      canAskAgain: true
    } as never)
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('sched-1')
    vi.mocked(Notifications.dismissNotificationAsync).mockResolvedValue(undefined)
  })

  it('keeps asking from the abandoned range until a catch-up actually succeeds', async () => {
    // The phone was offline while seqs 6-7 dispatched. The catch-up that would have
    // replayed them dies (socket close / timeout / ok:false), and live traffic keeps
    // flowing. If a live seq is allowed to persist past 6-7, the desktop cuts by
    // `seq > lastSeenSeq` on the next catch-up and they are gone for good — and the
    // window stays open until some catch-up succeeds, not for one round trip.
    storage.set(WATERMARK_KEY, JSON.stringify({ seq: 5, epoch: 'epoch-1' }))
    const host = makeHostClient()
    host.setOutcome({ kind: 'reject' })

    subscribeToDesktopNotifications(host.client, 'host-1')
    host.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
    await flushAsync()
    expect(host.askedFrom).toEqual([5])

    host.onData?.({ ...notification(11), notificationEpoch: 'epoch-1' })
    await flushAsync()
    expect(persistedSeq()).toBe(5)

    // Second catch-up also fails; the gap is still open.
    host.setOutcome({ kind: 'notOk' })
    host.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
    await flushAsync()
    host.onData?.({ ...notification(12), notificationEpoch: 'epoch-1' })
    await flushAsync()
    expect(host.askedFrom).toEqual([5, 5])
    expect(persistedSeq()).toBe(5)

    // Third succeeds and replays the abandoned range.
    host.setOutcome({ kind: 'ok', notifications: [notification(6), notification(7)] })
    host.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
    await flushAsync()

    expect(host.askedFrom).toEqual([5, 5, 5])
    const titles = vi
      .mocked(Notifications.scheduleNotificationAsync)
      .mock.calls.map((call) => (call[0] as { content: { title: string } }).content.title)
    expect(titles).toEqual(expect.arrayContaining(['m6', 'm7']))

    // Only now may the watermark move past the recovered range.
    expect(persistedSeq()).toBe(12)
    host.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
    await flushAsync()
    expect(host.askedFrom).toEqual([5, 5, 5, 12])
  })

  it('quarantines at the last replayed seq when a teardown cuts the batch short', async () => {
    // The batch can start before a teardown and still be draining after it, so the
    // events past the interruption were never shown. A live seq arriving on the next
    // connection must not persist over them.
    storage.set(WATERMARK_KEY, JSON.stringify({ seq: 5, epoch: 'epoch-1' }))
    const host = makeHostClient()
    host.setOutcome({
      kind: 'ok',
      notifications: [notification(6), notification(7), notification(8)]
    })

    let unsubscribe: (() => void) | null = null
    vi.mocked(Notifications.scheduleNotificationAsync).mockImplementation(async (request) => {
      if ((request as { content: { title: string } }).content.title === 'm6') {
        unsubscribe?.()
      }
      return 'sched-1'
    })

    unsubscribe = subscribeToDesktopNotifications(host.client, 'host-1')
    host.onData?.({ type: 'ready', subscriptionId: 'sub-1', epoch: 'epoch-1' })
    await flushAsync()

    const titles = vi
      .mocked(Notifications.scheduleNotificationAsync)
      .mock.calls.map((call) => (call[0] as { content: { title: string } }).content.title)
    expect(titles).toEqual(['m6'])

    // A fresh subscription on the same module-scope session takes a live seq 20 before
    // its own catch-up, then resumes from 6 rather than from 20.
    vi.mocked(Notifications.scheduleNotificationAsync).mockResolvedValue('sched-1')
    const host2 = makeHostClient()
    host2.setOutcome({ kind: 'ok', notifications: [notification(7), notification(8)] })
    subscribeToDesktopNotifications(host2.client, 'host-1')
    host2.onData?.({ ...notification(20), notificationEpoch: 'epoch-1' })
    await flushAsync()
    expect(persistedSeq()).toBe(6)

    host2.onData?.({ type: 'ready', subscriptionId: 'sub-2', epoch: 'epoch-1' })
    await flushAsync()

    expect(host2.askedFrom).toEqual([6])
    expect(persistedSeq()).toBe(20)
  })
})
