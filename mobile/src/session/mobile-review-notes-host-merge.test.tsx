import { createElement, useEffect, useRef, useState } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeDiffCommentMutation } from '../../../src/shared/diff-comment-mutation'
import type { DiffComment } from '../../../src/shared/diff-comment-types'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { useMobileSessionDiffComments } from './use-mobile-session-diff-comments'

vi.mock('../platform/haptics', () => ({
  triggerSuccess: vi.fn(),
  triggerError: vi.fn(),
  triggerSelection: vi.fn()
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => true }))

function note(id: string): DiffComment {
  return {
    id,
    worktreeId: 'workspace-1',
    filePath: 'src/a.ts',
    lineNumber: 3,
    body: `note ${id}`,
    createdAt: 1,
    side: 'modified'
  }
}

type SetParams = { diffComments: DiffComment[]; diffCommentsBase?: DiffComment[] }

/** A host holding the stored notes; `merges: false` is a host from before the base field. */
function fakeHost(initial: DiffComment[], options: { merges: boolean }) {
  const host = { notes: initial, holdShow: false, failNextSet: false }
  const heldShows: (() => void)[] = []
  const reply = (result: unknown): RpcResponse => ({
    id: 'x',
    ok: true,
    result,
    _meta: { runtimeId: 'r' }
  })
  const sendRequest = vi.fn((method: string, params?: unknown): Promise<RpcResponse> => {
    if (method === 'worktree.show') {
      const snapshot = host.notes
      return new Promise((resolve) => {
        const answer = () => resolve(reply({ worktree: { diffComments: snapshot } }))
        if (host.holdShow) {
          heldShows.push(answer)
        } else {
          answer()
        }
      })
    }
    if (method === 'worktree.set') {
      if (host.failNextSet) {
        host.failNextSet = false
        return Promise.resolve({ id: 'x', ok: false, error: { code: 'x', message: 'Disk full' } })
      }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hooks under test send only this shape to worktree.set.
      const { diffComments, diffCommentsBase } = params as SetParams
      host.notes =
        options.merges && diffCommentsBase
          ? mergeDiffCommentMutation(diffCommentsBase, host.notes, diffComments)
          : diffComments
      return Promise.resolve(reply({ worktree: { diffComments: host.notes } }))
    }
    return new Promise<RpcResponse>(() => {})
  })
  const client: RpcClient = {
    sendRequest,
    subscribe: () => () => {},
    updateTerminalSubscriptionViewport: () => {},
    getState: () => 'connected',
    getReconnectAttempt: () => 0,
    getLastConnectedAt: () => null,
    onStateChange: () => () => {},
    notifyForeground: () => {},
    close: () => {}
  }
  return { host, client, heldShows, sendRequest }
}

type Notes = ReturnType<typeof useMobileSessionDiffComments>
let renderer: ReactTestRenderer | undefined
let notes: Notes | undefined
let shown: DiffComment[] = []
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  notes = undefined
})

function hook(): Notes {
  if (!notes) {
    throw new Error('notes hook not mounted')
  }
  return notes
}

async function mountNotes(client: RpcClient): Promise<void> {
  function Harness() {
    const [diffComments, setDiffComments] = useState<DiffComment[]>([])
    const diffCommentsRef = useRef(diffComments)
    const [diffCommentBusy, setDiffCommentBusy] = useState(false)
    // Mirrors the session screen, which syncs the ref after each render.
    useEffect(() => {
      diffCommentsRef.current = diffComments
    }, [diffComments])
    shown = diffComments
    const scope = {
      worktreeId: 'workspace-1',
      isFloatingWorkspaceRoute: false,
      client,
      connState: 'connected',
      setDiffComments,
      diffCommentsRef,
      diffCommentBusy,
      setDiffCommentBusy,
      setPendingDiffNotesDelivery: () => {},
      showToast: () => {}
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scope carries every member the notes hook reads; a missing one throws on use.
    notes = useMobileSessionDiffComments(scope as never)
    return null
  }
  await act(async () => {
    renderer = create(createElement(Harness))
  })
}

const ids = (comments: readonly DiffComment[]) => comments.map((comment) => comment.id)

describe('mobile review notes saved against the host', () => {
  it('keeps a note added on desktop after the phone loaded when the phone adds and deletes', async () => {
    const { host, client } = fakeHost([note('a')], { merges: true })
    await mountNotes(client)
    host.notes = [...host.notes, note('desktop')]

    await act(async () => {
      await hook().addDiffCommentForFile('src/a.ts', 9, 'from phone')
    })
    await act(async () => hook().deleteDiffCommentForFile('a'))

    expect(ids(host.notes)).toEqual(['desktop', expect.stringMatching(/^mobile-/)])
    expect(ids(shown)).toEqual(ids(host.notes))
  })

  it('saves both notes when two are added in the same frame', async () => {
    const { host, client } = fakeHost([note('a')], { merges: true })
    await mountNotes(client)

    await act(async () => {
      await Promise.all([
        hook().addDiffCommentForFile('src/a.ts', 1, 'first'),
        hook().addDiffCommentForFile('src/a.ts', 2, 'second')
      ])
    })

    expect(host.notes.map((comment) => comment.body)).toEqual(['note a', 'first', 'second'])
    expect(ids(shown)).toEqual(ids(host.notes))
  })

  it('undoes only the failed change when a later save succeeded', async () => {
    const { host, client } = fakeHost([note('a'), note('b')], { merges: true })
    await mountNotes(client)
    host.failNextSet = true

    await act(async () => {
      await Promise.all([
        hook().deleteDiffCommentForFile('a'),
        hook().addDiffCommentForFile('src/a.ts', 2, 'kept')
      ])
    })

    expect(host.notes.map((comment) => comment.body)).toEqual(['note a', 'note b', 'kept'])
    expect(ids(shown).toSorted()).toEqual(ids(host.notes).toSorted())
  })

  it('does not let a slow first load replace a note saved after it', async () => {
    const { host, client, heldShows } = fakeHost([note('a')], { merges: true })
    host.holdShow = true
    await mountNotes(client)

    await act(async () => {
      await hook().addDiffCommentForFile('src/a.ts', 2, 'early')
    })
    await act(async () => heldShows.forEach((answer) => answer()))

    expect(shown.map((comment) => comment.body)).toEqual(['note a', 'early'])
  })

  it('still sends the full list, so a host without the merge replaces it as before', async () => {
    const { host, client, sendRequest } = fakeHost([note('a')], { merges: false })
    await mountNotes(client)

    await act(async () => {
      await hook().addDiffCommentForFile('src/a.ts', 2, 'phone')
    })

    const sent = sendRequest.mock.calls.find(([method]) => method === 'worktree.set')?.[1]
    expect(sent).toMatchObject({ diffComments: [note('a'), { body: 'phone' }] })
    expect(host.notes.map((comment) => comment.body)).toEqual(['note a', 'phone'])
    expect(shown).toEqual(host.notes)
  })
})
