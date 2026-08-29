// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  clearNativeChatAttachmentCacheForTests,
  readNativeChatAttachmentCache,
  useNativeChatComposerAttachments
} from './use-native-chat-composer-attachments'
import type { NativeChatResolvedTarget } from './native-chat-composer-target'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  isRemoteRuntimePtyId: () => false
}))

type AttachmentApi = ReturnType<typeof useNativeChatComposerAttachments>
type ProbeApi = AttachmentApi & { adoptDraft: (draft: string) => void }

const target: NativeChatResolvedTarget = {
  ptyId: 'pty-1',
  settings: { activeRuntimeEnvironmentId: null }
}

function Probe({
  scopeKey,
  structured = false,
  disabled = false,
  isComposing,
  onReady
}: {
  scopeKey: string
  structured?: boolean
  disabled?: boolean
  isComposing: () => boolean
  onReady: (api: ProbeApi) => void
}): React.JSX.Element {
  const [caret, setCaret] = useState(0)
  const [draftValue, setDraftValue] = useState('')
  const [, setNotice] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const api = useNativeChatComposerAttachments({
    attachmentScopeKey: scopeKey,
    allowWithoutTarget: structured,
    caret,
    disabled,
    isComposing,
    resolveTarget: () => (structured ? null : target),
    textareaRef,
    setCaret,
    setDraft: (updater) => setDraftValue((previous) => updater(previous)),
    setNotice
  })
  onReady({ ...api, adoptDraft: setDraftValue })
  return (
    <div>
      <textarea ref={textareaRef} />
      <output>{draftValue}</output>
    </div>
  )
}

async function renderProbe(
  scopeKey: string,
  structured = false,
  options: { disabled?: boolean; isComposing?: () => boolean } = {}
): Promise<{
  draft: () => string
  latest: () => ProbeApi
  rerender: (scopeKey: string, disabled?: boolean) => Promise<void>
  root: Root
  textarea: () => HTMLTextAreaElement
}> {
  const container = document.createElement('div')
  document.body.append(container)
  // onReady fires on every render, so keep the freshest snapshot — reading a
  // single captured `api` would go stale after attach/remove triggers a render.
  let api: ProbeApi | null = null
  const root = createRoot(container)
  const onReady = (next: ProbeApi): void => {
    api = next
  }
  const isComposing = options.isComposing ?? (() => false)
  const render = async (nextScopeKey: string, disabled: boolean): Promise<void> => {
    await act(async () => {
      root.render(
        createElement(Probe, {
          scopeKey: nextScopeKey,
          structured,
          disabled,
          isComposing,
          onReady
        })
      )
    })
  }
  await render(scopeKey, options.disabled ?? false)
  if (!api) {
    throw new Error('Probe did not render')
  }
  return {
    draft: () => container.querySelector('output')?.textContent ?? '',
    root,
    latest: () => {
      if (!api) {
        throw new Error('Probe is not mounted')
      }
      return api
    },
    rerender: (nextScopeKey: string, disabled = options.disabled ?? false) =>
      render(nextScopeKey, disabled),
    textarea: () => {
      const textarea = container.querySelector('textarea')
      if (!textarea) {
        throw new Error('Probe textarea is not mounted')
      }
      return textarea
    }
  }
}

describe('useNativeChatComposerAttachments', () => {
  afterEach(() => {
    clearNativeChatAttachmentCacheForTests()
    document.body.replaceChildren()
  })

  it('holds attached images as chips (deferred to submit) and restores them on remount', async () => {
    const first = await renderProbe('pty-1')

    await act(async () => {
      first.latest().attachResolvedPaths(['/tmp/orca-native-chat-attach-test.png'])
    })

    // Images are NOT sent to the TUI on attach — they ride along on submit, so
    // the chip and the TUI input never diverge and removing a chip is clean.
    expect(first.latest().imageAttachments).toMatchObject([
      { path: '/tmp/orca-native-chat-attach-test.png' }
    ])
    expect(readNativeChatAttachmentCache('pty-1')).toMatchObject([
      { path: '/tmp/orca-native-chat-attach-test.png' }
    ])

    act(() => first.root.unmount())
    const second = await renderProbe('pty-1')

    expect(second.latest().imageAttachments).toMatchObject([
      { path: '/tmp/orca-native-chat-attach-test.png' }
    ])
    act(() => second.root.unmount())
  })

  it('accepts host-readable image paths without a PTY for structured transport', async () => {
    const probe = await renderProbe('structured-session-1', true)

    await act(async () => {
      probe.latest().attachResolvedPaths(['/tmp/structured-image.png'])
    })

    expect(probe.latest().imageAttachments).toMatchObject([{ path: '/tmp/structured-image.png' }])
    act(() => probe.root.unmount())
  })

  it('removes an attached image chip cleanly', async () => {
    const probe = await renderProbe('pty-1')
    await act(async () => {
      probe.latest().attachResolvedPaths(['/tmp/orca-native-chat-remove-test.png'])
    })
    const id = probe.latest().imageAttachments[0]?.id
    expect(id).toBeDefined()
    await act(async () => {
      probe.latest().removeImageAttachment(id as string)
    })
    expect(probe.latest().imageAttachments).toMatchObject([])
    expect(readNativeChatAttachmentCache('pty-1')).toMatchObject([])
    act(() => probe.root.unmount())
  })

  it('adopts browser text before draining ordered duplicate paths exactly once', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })
    const textarea = probe.textarea()
    textarea.focus()
    textarea.value = '각 '
    textarea.setSelectionRange(2, 2)
    const focus = vi.spyOn(textarea, 'focus')

    act(() => {
      probe.latest().attachResolvedPaths(['/remote/b.txt', '/remote/b.txt'])
      probe.latest().attachResolvedPaths(['/remote/a.txt'])
    })
    expect(probe.draft()).toBe('')

    composing = false
    textarea.blur()
    act(() => {
      probe.latest().adoptDraft(textarea.value)
      probe.latest().flushPendingAttachments()
      probe.latest().flushPendingAttachments()
    })

    expect(probe.draft()).toBe('각 @/remote/b.txt @/remote/b.txt @/remote/a.txt ')
    expect(focus).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(textarea)
    act(() => probe.root.unmount())
  })

  it('drops queued paths after any disabled transition', async () => {
    let composing = true
    const probe = await renderProbe('pty-1', false, { isComposing: () => composing })

    act(() => probe.latest().attachResolvedPaths(['/remote/a.txt']))
    await probe.rerender('pty-1', true)
    await probe.rerender('pty-1', false)
    composing = false
    act(() => probe.latest().flushPendingAttachments())

    expect(probe.draft()).toBe('')
    act(() => probe.root.unmount())
  })
})
