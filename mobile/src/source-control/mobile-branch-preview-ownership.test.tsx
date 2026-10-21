import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeRpcClient } from '../mobile-web-shell/bridge-host-test-fakes'
import type { RpcResponse } from '../transport/types'
import { useMobileSourceControlOpeners } from './use-mobile-source-control-openers'

vi.mock('../navigation/route-handoff', () => ({
  useRouteHandoff: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() })
}))
vi.mock('../platform/haptics', () => ({ triggerError: vi.fn(), triggerSelection: vi.fn() }))

const entry = { path: 'src/app.ts', status: 'modified' } as const
const summary = {
  baseRef: 'main',
  headOid: 'head',
  mergeBase: 'base',
  status: 'ready',
  changedFiles: 1,
  commitsAhead: 1,
  errorMessage: undefined
} as const
const success: RpcResponse = {
  id: 'branch-diff',
  ok: true,
  result: { kind: 'text', originalContent: 'old', modifiedContent: 'new' }
}

describe('committed diff preview ownership', () => {
  let renderer: ReactTestRenderer | null = null
  let latest: ReturnType<typeof useMobileSourceControlOpeners> | null = null
  const replies: ((response: RpcResponse) => void)[] = []
  const client = createFakeRpcClient()
  client.sendRequest = () => new Promise((resolve) => replies.push(resolve))
  function Probe({ worktreeId = 'wt-1' }: { worktreeId?: string }) {
    latest = useMobileSourceControlOpeners({
      client,
      connState: 'connected',
      hostId: 'host-1',
      worktreeId,
      name: 'api',
      origin: 'session',
      embedded: true,
      branchCompareState: { kind: 'ready', result: { summary, entries: [entry] } },
      mountedRef: { current: true },
      busyActionRef: { current: null },
      setActionError: vi.fn()
    })
    return null
  }
  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    latest = null
    replies.length = 0
  })
  function mount() {
    act(() => {
      renderer = create(createElement(Probe))
    })
  }
  function open() {
    let pending: Promise<void> | undefined
    act(() => {
      pending = latest?.openBranchDiff(entry)
    })
    return pending
  }
  it.each(['success', 'refusal'])(
    'does not reopen a dismissed loading drawer when its %s arrives',
    async (outcome) => {
      mount()
      const pending = open()
      expect(latest?.branchDiffPreview?.kind).toBe('loading')
      act(() => latest?.setBranchDiffPreview(null))
      await act(async () => {
        replies[0]?.(
          outcome === 'success'
            ? success
            : {
                id: 'branch-diff',
                ok: false,
                error: { code: 'runtime_error', message: 'Read failed' }
              }
        )
        await pending
      })
      expect(latest?.branchDiffPreview).toBeNull()
    }
  )
  it('allows a new preview after dismissal and keeps it owned when the old reply arrives', async () => {
    mount()
    const old = open()
    act(() => latest?.setBranchDiffPreview(null))
    const current = open()
    expect(replies).toHaveLength(2)
    await act(async () => {
      replies[0]?.(success)
      await old
    })
    expect(latest?.branchDiffPreview?.kind).toBe('loading')
    expect(latest?.openingBranchPath).toBe(entry.path)
    await act(async () => {
      replies[1]?.(success)
      await current
    })
    expect(latest?.branchDiffPreview?.kind).toBe('ready')
  })
  it('retires the preview when this mounted route changes workspace', async () => {
    mount()
    const pending = open()
    act(() => renderer?.update(createElement(Probe, { worktreeId: 'wt-2' })))
    expect(latest?.branchDiffPreview).toBeNull()
    await act(async () => {
      replies[0]?.(success)
      await pending
    })
    expect(latest?.branchDiffPreview).toBeNull()
  })
})
