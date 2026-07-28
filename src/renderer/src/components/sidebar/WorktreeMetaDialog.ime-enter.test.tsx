// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WorktreeMetaDialog from './WorktreeMetaDialog'

const { closeModal, updateWorktreeMeta } = vi.hoisted(() => ({
  closeModal: vi.fn(),
  updateWorktreeMeta: vi.fn(async () => undefined)
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeModal: 'edit-meta',
      modalData: { worktreeId: 'repo::/repo', currentDisplayName: '', focus: 'comment' },
      closeModal,
      updateWorktreeMeta,
      fetchIssue: vi.fn(),
      worktreesByRepo: {}
    })
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>
}))

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  updateWorktreeMeta.mockClear()
  closeModal.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  document.body.innerHTML = ''
})

function renderDialog(): {
  displayNameInput: HTMLInputElement
  issueInput: HTMLInputElement
  prInput: HTMLInputElement
  comment: HTMLTextAreaElement
} {
  act(() => {
    root.render(<WorktreeMetaDialog />)
  })
  const inputs = Array.from(document.body.querySelectorAll('input'))
  const comment = document.body.querySelector('textarea')
  if (inputs.length !== 3 || !comment) {
    throw new Error('worktree meta fields not rendered')
  }
  return {
    displayNameInput: inputs[0],
    issueInput: inputs[1],
    prInput: inputs[2],
    comment
  }
}

function pressEnter(element: HTMLElement, init?: KeyboardEventInit & { keyCode?: number }): void {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ...init
  })
  if (init?.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  }
  act(() => {
    element.dispatchEvent(event)
  })
}

function changeValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  act(() => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('WorktreeMetaDialog IME Enter guard', () => {
  it('does not save the note on the Enter that commits an IME composition', () => {
    const { comment } = renderDialog()

    pressEnter(comment, { isComposing: true })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not save it for IMEs that report keyCode 229 without isComposing', () => {
    const { comment } = renderDialog()

    pressEnter(comment, { keyCode: 229 })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not save the display name on an IME-composition Enter', () => {
    const { displayNameInput } = renderDialog()

    pressEnter(displayNameInput, { isComposing: true })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it.each(['issueInput', 'prInput'] as const)(
    'does not save the %s on keyCode 229 Enter',
    (field) => {
      const inputs = renderDialog()

      pressEnter(inputs[field], { keyCode: 229 })

      expect(updateWorktreeMeta).not.toHaveBeenCalled()
    }
  )

  it('does not save a composition Enter with the platform submit modifier', () => {
    const { comment } = renderDialog()
    const modifier = navigator.userAgent.includes('Mac') ? { metaKey: true } : { ctrlKey: true }

    pressEnter(comment, { isComposing: true, ...modifier })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('keeps Shift+Enter available for a note newline', () => {
    const { comment } = renderDialog()

    pressEnter(comment, { shiftKey: true })

    expect(updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('saves with the platform submit modifier', () => {
    const { displayNameInput, comment } = renderDialog()
    const modifier = navigator.userAgent.includes('Mac') ? { metaKey: true } : { ctrlKey: true }
    changeValue(displayNameInput, '最新の名前')

    pressEnter(comment, modifier)

    expect(updateWorktreeMeta).toHaveBeenCalledWith(
      'repo::/repo',
      expect.objectContaining({ displayName: '最新の名前' })
    )
  })

  it('keeps the dialog open on an IME-composition Escape', () => {
    const { comment } = renderDialog()

    act(() => {
      comment.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          isComposing: true,
          bubbles: true,
          cancelable: true
        })
      )
    })

    expect(closeModal).not.toHaveBeenCalled()
  })

  it('still saves on a plain Enter', () => {
    const { comment } = renderDialog()

    pressEnter(comment)

    expect(updateWorktreeMeta).toHaveBeenCalledTimes(1)
  })
})
