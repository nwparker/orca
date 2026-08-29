import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { translate } from '@/i18n/i18n'
import { isNativeChatImageAttachmentPath } from './native-chat-image-paste'
import {
  formatNativeChatFileReference,
  nativeChatComposerTargetIsRemote,
  type NativeChatResolvedTarget
} from './native-chat-composer-target'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'
import { setBoundedScopeCacheEntry } from './native-chat-composer-scope-cache'

export type UseNativeChatComposerAttachmentsArgs = {
  attachmentScopeKey: string
  allowWithoutTarget?: boolean
  caret: number
  disabled: boolean
  isComposing: () => boolean
  resolveTarget: () => NativeChatResolvedTarget | null
  textareaRef: RefObject<HTMLTextAreaElement | null>
  setCaret: (caret: number) => void
  setDraft: (updater: (previous: string) => string) => void
  setNotice: (notice: string | null) => void
}

export function useNativeChatComposerAttachments({
  attachmentScopeKey,
  allowWithoutTarget = false,
  caret,
  disabled,
  isComposing,
  resolveTarget,
  textareaRef,
  setCaret,
  setDraft,
  setNotice
}: UseNativeChatComposerAttachmentsArgs): {
  imageAttachments: NativeChatComposerImageAttachment[]
  attachResolvedPaths: (paths: string[]) => void
  clearImageAttachments: () => void
  flushPendingAttachments: () => void
  removeImageAttachment: (id: string) => void
} {
  const [imageAttachments, setImageAttachments] = useState<NativeChatComposerImageAttachment[]>(
    () => readNativeChatAttachmentCache(attachmentScopeKey)
  )
  const imageAttachmentCounter = useRef(0)
  const pendingResolvedPathsRef = useRef<string[]>([])
  const disabledRef = useRef(disabled)

  useLayoutEffect(() => {
    disabledRef.current = disabled
    if (disabled) {
      pendingResolvedPathsRef.current = []
    }
  }, [disabled])

  const updateImageAttachments = useCallback(
    (
      updater: (
        previous: NativeChatComposerImageAttachment[]
      ) => NativeChatComposerImageAttachment[]
    ) => {
      setImageAttachments((prev) => {
        const next = updater(prev)
        writeNativeChatAttachmentCache(attachmentScopeKey, next)
        return next
      })
    },
    [attachmentScopeKey]
  )

  const appendImageAttachments = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) {
        return
      }
      updateImageAttachments((prev) => [
        ...prev,
        ...paths.map((path) => {
          imageAttachmentCounter.current += 1
          return { id: `${Date.now()}-${imageAttachmentCounter.current}`, path }
        })
      ])
    },
    [updateImageAttachments]
  )

  const insertFileReferences = useCallback(
    (paths: string[]) => {
      const references = paths.map(formatNativeChatFileReference).join(' ')
      if (references.length === 0) {
        return
      }
      const insertion = `${references} `
      const caretAtInsert = textareaRef.current?.selectionStart ?? caret
      setDraft((prev) => {
        const before = prev.slice(0, caretAtInsert)
        const after = prev.slice(caretAtInsert)
        const next = before + insertion + after
        setCaret(before.length + insertion.length)
        return next
      })
    },
    [caret, setCaret, setDraft, textareaRef]
  )

  // Attach paths the TARGET AGENT can read: local paths for local worktrees,
  // already-uploaded remote paths for SSH worktrees (the composer uploads
  // before calling this — see native-chat-attachment-upload.ts).
  const applyResolvedPaths = useCallback(
    (paths: string[], focus: boolean) => {
      const target = resolveTarget()
      if (
        (!target && !allowWithoutTarget) ||
        (target && nativeChatComposerTargetIsRemote(target.ptyId))
      ) {
        setNotice(
          translate(
            'components.native-chat.composer.localAttachmentUnsupported',
            'Local attachments are not available for remote sessions.'
          )
        )
        return
      }
      const imagePaths = paths.filter(isNativeChatImageAttachmentPath)
      const filePaths = paths.filter((path) => !isNativeChatImageAttachmentPath(path))
      // Images are NOT sent to the TUI here — they ride along on submit (see
      // NativeChatComposer.send) so the GUI chips and the TUI input never
      // diverge and removing a chip needs no TUI un-paste.
      appendImageAttachments(imagePaths)
      insertFileReferences(filePaths)
      setNotice(null)
      if (focus && paths.length > 0) {
        requestAnimationFrame(() => textareaRef.current?.focus())
      }
    },
    [
      allowWithoutTarget,
      appendImageAttachments,
      insertFileReferences,
      resolveTarget,
      setNotice,
      textareaRef
    ]
  )

  const attachResolvedPaths = useCallback(
    (paths: string[]) => {
      if (paths.length === 0 || disabledRef.current) {
        return
      }
      if (isComposing()) {
        pendingResolvedPathsRef.current.push(...paths)
        return
      }
      applyResolvedPaths(paths, true)
    },
    [applyResolvedPaths, isComposing]
  )

  const flushPendingAttachments = useCallback(() => {
    const paths = pendingResolvedPathsRef.current
    pendingResolvedPathsRef.current = []
    if (paths.length === 0 || disabledRef.current) {
      return
    }
    applyResolvedPaths(paths, false)
  }, [applyResolvedPaths])

  return {
    imageAttachments,
    attachResolvedPaths,
    clearImageAttachments: () => updateImageAttachments(() => []),
    flushPendingAttachments,
    removeImageAttachment: (id) =>
      updateImageAttachments((prev) => prev.filter((attachment) => attachment.id !== id))
  }
}

const attachmentCache = new Map<string, NativeChatComposerImageAttachment[]>()

export function readNativeChatAttachmentCache(
  scopeKey: string
): NativeChatComposerImageAttachment[] {
  return [...(attachmentCache.get(scopeKey) ?? [])]
}

function writeNativeChatAttachmentCache(
  scopeKey: string,
  attachments: readonly NativeChatComposerImageAttachment[]
): void {
  if (attachments.length === 0) {
    attachmentCache.delete(scopeKey)
    return
  }
  // LRU-bounded so pending attachments for permanently-removed panes can't accumulate.
  setBoundedScopeCacheEntry(attachmentCache, scopeKey, [...attachments])
}

export function clearNativeChatAttachmentCacheForTests(): void {
  attachmentCache.clear()
}
