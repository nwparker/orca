// @vitest-environment happy-dom

import { createRef } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./NativeChatComposerActions', () => ({
  NativeChatComposerActions: () => <div data-testid="composer-actions" />
}))

vi.mock('./NativeChatAutocompleteMenus', () => ({
  NativeChatMentionHint: () => null,
  NativeChatPickerMenu: () => null
}))

import {
  NativeChatComposerField,
  type NativeChatComposerFieldProps
} from './NativeChatComposerField'

afterEach(() => cleanup())

function fieldProps(
  overrides: Partial<NativeChatComposerFieldProps> = {}
): NativeChatComposerFieldProps {
  return {
    textareaRef: createRef<HTMLTextAreaElement>(),
    draft: '',
    disabled: false,
    hasPty: true,
    canSend: true,
    autocomplete: { mode: 'none' },
    activeSuggestion: 0,
    notice: null,
    imageAttachments: [],
    sendButtonDisabled: false,
    isWorking: false,
    attachDisabled: false,
    dictationDisabled: false,
    isDictating: false,
    isDictationHoldMode: false,
    onDraftChange: vi.fn(),
    onTextareaSelect: vi.fn(),
    onKeyDown: vi.fn(),
    onCompositionStart: vi.fn(),
    onCompositionEnd: vi.fn(),
    onBlur: vi.fn(),
    onPaste: vi.fn(),
    pickerListboxId: 'picker',
    onChoosePickerItem: vi.fn(),
    onRetrySkills: vi.fn(),
    onAcceptMention: vi.fn(),
    onRemoveImageAttachment: vi.fn(),
    onAttach: vi.fn(),
    onDictationToggle: vi.fn(),
    onDictationHoldStart: vi.fn(),
    onDictationHoldEnd: vi.fn(),
    onSend: vi.fn(),
    sessionOptionsSurface: null,
    sessionOptionsSnapshot: [],
    ...overrides
  }
}

function textarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement
}

describe('native chat composer composition ownership', () => {
  it('preserves the focused browser preedit through 120 stale streaming rerenders', () => {
    const textareaRef = createRef<HTMLTextAreaElement>()
    const onCompositionEnd = vi.fn()
    const props = fieldProps({ textareaRef, onCompositionEnd })
    const view = render(<NativeChatComposerField {...props} />)
    const input = textarea()
    input.focus()
    fireEvent.compositionStart(input)
    input.value = '가'

    for (let index = 0; index < 120; index += 1) {
      view.rerender(<NativeChatComposerField {...props} draft={`stale streaming draft ${index}`} />)
      expect(textarea()).toBe(input)
      expect(document.activeElement).toBe(input)
      expect(input.value).toBe('가')
    }

    fireEvent.compositionEnd(input, { data: '가' })
    expect(onCompositionEnd).toHaveBeenCalledOnce()
    expect(input.value).toBe('가')
  })

  it('synchronizes launch, programmatic, cleared, and pane-scoped drafts while idle', () => {
    const textareaRef = createRef<HTMLTextAreaElement>()
    const props = fieldProps({ textareaRef, draft: 'launch draft' })
    const view = render(<NativeChatComposerField {...props} />)
    const input = textarea()

    for (const draft of ['programmatic insertion', '', 'next pane draft']) {
      view.rerender(<NativeChatComposerField {...props} draft={draft} />)
      expect(textarea()).toBe(input)
      expect(input.value).toBe(draft)
    }
  })

  it('keeps adopting change events and exposes the final deletion at composition end', () => {
    const onDraftChange = vi.fn()
    let settledValue: string | null = null
    render(
      <NativeChatComposerField
        {...fieldProps({
          draft: '한',
          onDraftChange,
          onCompositionEnd: (event) => {
            settledValue = event.currentTarget.value
          }
        })}
      />
    )
    const input = textarea()
    fireEvent.compositionStart(input)
    fireEvent.change(input, { target: { value: '한글' } })
    expect(onDraftChange).toHaveBeenLastCalledWith('한글', input)

    input.value = ''
    fireEvent.compositionEnd(input, { data: '' })
    expect(settledValue).toBe('')
  })

  it('uses the shared Enter gesture owner without swallowing the next deliberate Enter', () => {
    const onKeyDown = vi.fn()
    render(<NativeChatComposerField {...fieldProps({ draft: '가', onKeyDown })} />)
    const input = textarea()
    fireEvent.compositionStart(input)

    fireEvent.keyDown(input, { key: 'Process', keyCode: 229, isComposing: true })
    fireEvent.compositionEnd(input, { data: '가' })
    const redispatch = fireEvent.keyDown(input, {
      key: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(redispatch).toBe(false)
    expect(onKeyDown).not.toHaveBeenCalled()

    fireEvent.keyUp(input, { key: 'Enter', keyCode: 13 })
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false })
    expect(onKeyDown).toHaveBeenCalledOnce()
  })

  it('releases composition ownership on blur even when compositionend is omitted', () => {
    const onBlur = vi.fn()
    const onKeyDown = vi.fn()
    const props = fieldProps({ draft: '가', onBlur, onKeyDown })
    const view = render(<NativeChatComposerField {...props} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    input.value = '각'

    fireEvent.blur(input)
    view.rerender(<NativeChatComposerField {...props} draft="external draft" />)
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13, isComposing: false })

    expect(onBlur).toHaveBeenCalledOnce()
    expect(input.value).toBe('external draft')
    expect(onKeyDown).toHaveBeenCalledOnce()
  })

  it('applies a draft deferred before blur when compositionend is omitted', () => {
    const onBlur = vi.fn()
    const props = fieldProps({ onBlur })
    const view = render(<NativeChatComposerField {...props} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    input.value = '각'

    view.rerender(<NativeChatComposerField {...props} draft="next pane draft" />)
    expect(input.value).toBe('각')
    fireEvent.blur(input)

    expect(onBlur).toHaveBeenCalledOnce()
    expect(input.value).toBe('next pane draft')
  })

  it('adopts the browser value on blur when compositionend is omitted without a deferred draft', () => {
    const onDraftChange = vi.fn()
    render(<NativeChatComposerField {...fieldProps({ onDraftChange })} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    input.value = '각'

    fireEvent.blur(input)

    expect(onDraftChange).toHaveBeenCalledOnce()
    expect(onDraftChange).toHaveBeenCalledWith('각', input)
  })

  it('does not mistake a same-draft streaming rerender for a deferred draft', () => {
    const onDraftChange = vi.fn()
    const props = fieldProps({ onDraftChange })
    const view = render(<NativeChatComposerField {...props} />)
    const input = textarea()
    fireEvent.compositionStart(input)
    input.value = '각'

    view.rerender(<NativeChatComposerField {...props} />)
    fireEvent.blur(input)

    expect(input.value).toBe('각')
    expect(onDraftChange).toHaveBeenCalledWith('각', input)
  })
})
