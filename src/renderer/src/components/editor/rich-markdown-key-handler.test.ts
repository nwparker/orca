import { describe, expect, it, vi } from 'vitest'
import { Editor } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { Markdown } from '@tiptap/markdown'
import { createRichMarkdownKeyHandler, type KeyHandlerContext } from './rich-markdown-key-handler'

const extensions = [StarterKit, Markdown.configure({ markedOptions: { gfm: true } })]

function createEditor(content: object): Editor {
  return new Editor({
    element: null,
    extensions,
    content
  })
}

function keyEvent(
  key: string,
  overrides: Partial<KeyboardEvent> = {}
): KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> } {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...overrides
  } as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> }
}

function createContext(editor: Editor, typedMarker: boolean): KeyHandlerContext {
  return {
    isMac: true,
    editorRef: { current: editor },
    rootRef: { current: null },
    lastCommittedMarkdownRef: { current: '' },
    onContentChangeRef: { current: vi.fn() },
    onSaveRef: { current: vi.fn() },
    isEditingLinkRef: { current: false },
    slashMenuRef: { current: null },
    filteredSlashCommandsRef: { current: [] },
    selectedCommandIndexRef: { current: 0 },
    docLinkMenuRef: { current: null },
    filteredDocLinkRowsRef: { current: [] },
    selectedDocLinkIndexRef: { current: 0 },
    handleLocalImagePickRef: { current: vi.fn() },
    handleEmojiPickRef: { current: vi.fn() },
    typedEmptyOrderedListMarkerRef: { current: typedMarker },
    flushPendingSerialization: vi.fn(),
    openSearchRef: { current: vi.fn() },
    setIsEditingLink: vi.fn(),
    setLinkBubble: vi.fn(),
    setSelectedCommandIndex: vi.fn(),
    setSelectedDocLinkIndex: vi.fn(),
    setSlashMenu: vi.fn(),
    setDocLinkMenu: vi.fn()
  }
}

function emptyTopLevelOrderedList(): object {
  return {
    type: 'doc',
    content: [
      {
        type: 'orderedList',
        attrs: { start: 1, type: null },
        content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }]
      }
    ]
  }
}

function createFakeEditor() {
  const chain = {
    deleteRange: vi.fn(() => chain),
    focus: vi.fn(() => chain),
    insertContentAt: vi.fn(() => chain),
    run: vi.fn(() => true),
    toggleStrike: vi.fn(() => chain)
  }
  const editor = {
    chain: vi.fn(() => chain),
    commands: {
      focus: vi.fn(),
      insertContent: vi.fn(),
      liftListItem: vi.fn(() => false),
      sinkListItem: vi.fn(() => false)
    },
    getAttributes: vi.fn(() => ({ href: 'https://example.test' })),
    getMarkdown: vi.fn(() => '# Saved'),
    isActive: vi.fn(() => false),
    view: { composing: false }
  } as unknown as Editor
  return { chain, editor }
}

describe('rich markdown key handler', () => {
  it('preserves a typed empty ordered-list shortcut on Enter', () => {
    const editor = createEditor(emptyTopLevelOrderedList())

    try {
      editor.commands.setTextSelection(3)
      const ctx = createContext(editor, true)
      const event = keyEvent('Enter')

      expect(createRichMarkdownKeyHandler(ctx)(null, event)).toBe(true)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(ctx.typedEmptyOrderedListMarkerRef.current).toBe(false)
      expect(editor.getMarkdown()).toBe('1.\n\n')
    } finally {
      editor.destroy()
    }
  })

  it('leaves toolbar-created empty ordered lists to the default Enter behavior', () => {
    const editor = createEditor(emptyTopLevelOrderedList())

    try {
      editor.commands.setTextSelection(3)
      const event = keyEvent('Enter')

      expect(createRichMarkdownKeyHandler(createContext(editor, false))(null, event)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(editor.state.doc.toJSON()).toEqual(emptyTopLevelOrderedList())
    } finally {
      editor.destroy()
    }
  })

  it('does not rewrite empty ordered-list input during IME composition', () => {
    const editor = createEditor(emptyTopLevelOrderedList())

    try {
      editor.commands.setTextSelection(3)
      const event = keyEvent('Enter', { isComposing: true })

      expect(createRichMarkdownKeyHandler(createContext(editor, true))(null, event)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(editor.state.doc.toJSON()).toEqual(emptyTopLevelOrderedList())
    } finally {
      editor.destroy()
    }
  })

  it('lets slash-menu filter input fall through to document input', () => {
    const editor = createEditor({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '/' }] }]
    })

    try {
      editor.commands.setTextSelection(2)
      let slashMenu = { query: '', from: 1, to: 2, left: 0, top: 0 }
      const ctx = createContext(editor, false)
      ctx.slashMenuRef.current = slashMenu
      ctx.filteredSlashCommandsRef.current = [{ id: 'heading-1' } as never]
      ctx.setSlashMenu = vi.fn((next) => {
        slashMenu = typeof next === 'function' ? next(slashMenu) : next
        ctx.slashMenuRef.current = slashMenu
      })
      const event = keyEvent('h')

      expect(createRichMarkdownKeyHandler(ctx)(null, event)).toBe(false)
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(editor.getText()).toBe('/')
      expect(ctx.slashMenuRef.current?.query).toBe('')
    } finally {
      editor.destroy()
    }
  })

  it('handles search, save, strike, link-edit, and tab shortcuts', () => {
    const { chain, editor } = createFakeEditor()
    const ctx = createContext(editor, false)
    const handler = createRichMarkdownKeyHandler(ctx)

    expect(handler(null, keyEvent('f', { metaKey: true }))).toBe(true)
    expect(ctx.openSearchRef.current).toHaveBeenCalled()

    expect(handler(null, keyEvent('s', { metaKey: true }))).toBe(true)
    expect(ctx.flushPendingSerialization).toHaveBeenCalled()
    expect(ctx.onContentChangeRef.current).toHaveBeenCalledWith('# Saved')
    expect(ctx.onSaveRef.current).toHaveBeenCalledWith('# Saved')

    expect(handler(null, keyEvent('x', { metaKey: true, shiftKey: true }))).toBe(true)
    expect(chain.toggleStrike).toHaveBeenCalled()

    ctx.isEditingLinkRef.current = true
    expect(handler(null, keyEvent('k', { metaKey: true }))).toBe(true)
    expect(ctx.setIsEditingLink).toHaveBeenCalledWith(false)
    expect(ctx.setLinkBubble).toHaveBeenCalledWith(null)
    expect(editor.commands.focus).toHaveBeenCalled()

    expect(handler(null, keyEvent('Tab', { shiftKey: true }))).toBe(true)
    expect(editor.commands.liftListItem).toHaveBeenCalledWith('listItem')
    expect(editor.commands.liftListItem).toHaveBeenCalledWith('taskItem')

    vi.mocked(editor.isActive).mockReturnValueOnce(true)
    expect(handler(null, keyEvent('Tab'))).toBe(true)
    expect(editor.commands.insertContent).toHaveBeenCalledWith('  ')
  })

  it('navigates and commits doc-link menu rows before slash menu handling', () => {
    const { chain, editor } = createFakeEditor()
    const ctx = createContext(editor, false)
    const actionRun = vi.fn()
    ctx.docLinkMenuRef.current = { query: 'doc', from: 2, to: 7, left: 0, top: 0 }
    ctx.filteredDocLinkRowsRef.current = [
      { kind: 'action', id: 'create', label: 'Create doc', run: actionRun }
    ]
    const handler = createRichMarkdownKeyHandler(ctx)

    expect(handler(null, keyEvent('ArrowDown'))).toBe(true)
    expect(ctx.setSelectedDocLinkIndex).toHaveBeenCalledWith(expect.any(Function))
    expect(handler(null, keyEvent('ArrowUp'))).toBe(true)
    expect(handler(null, keyEvent('Enter'))).toBe(true)
    expect(chain.deleteRange).toHaveBeenCalledWith({ from: 2, to: 7 })
    expect(actionRun).toHaveBeenCalledWith(editor)
    expect(handler(null, keyEvent('Escape'))).toBe(true)
    expect(ctx.setDocLinkMenu).toHaveBeenCalledWith(null)

    ctx.filteredDocLinkRowsRef.current = []
    expect(handler(null, keyEvent('Tab'))).toBe(false)
  })

  it('updates, navigates, commits, and closes slash menus', () => {
    const { chain, editor } = createFakeEditor()
    const ctx = createContext(editor, false)
    const commandRun = vi.fn()
    let slashMenu = { query: 'ab', from: 1, to: 4, left: 0, top: 0 }
    ctx.slashMenuRef.current = slashMenu
    ctx.filteredSlashCommandsRef.current = [
      {
        id: 'text',
        label: 'Text',
        aliases: [],
        description: '',
        group: 'Basic blocks',
        icon: { kind: 'text', value: 'T' },
        run: commandRun
      }
    ]
    ctx.setSlashMenu = vi.fn((next) => {
      slashMenu = typeof next === 'function' ? next(slashMenu) : next
      ctx.slashMenuRef.current = slashMenu
    })
    const handler = createRichMarkdownKeyHandler(ctx)

    expect(handler(null, keyEvent('c'))).toBe(false)
    expect(ctx.slashMenuRef.current?.query).toBe('ab')
    expect(ctx.setSelectedCommandIndex).not.toHaveBeenCalledWith(0)

    expect(handler(null, keyEvent('Backspace', { isComposing: true }))).toBe(false)
    expect(ctx.slashMenuRef.current?.query).toBe('ab')

    expect(handler(null, keyEvent('ArrowDown'))).toBe(true)
    expect(ctx.setSelectedCommandIndex).toHaveBeenCalledWith(expect.any(Function))
    expect(handler(null, keyEvent('ArrowUp'))).toBe(true)

    expect(handler(null, keyEvent('Enter'))).toBe(true)
    expect(chain.deleteRange).toHaveBeenCalledWith({ from: 1, to: 4 })
    expect(commandRun).toHaveBeenCalledWith(editor)

    expect(handler(null, keyEvent('Escape'))).toBe(true)
    expect(ctx.setSlashMenu).toHaveBeenCalledWith(null)
  })
})
