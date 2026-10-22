// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { useRef, type ComponentProps } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { TooltipProvider } from '@/components/ui/tooltip'
import { resetLocalImageSrcStateForTests } from '@/components/editor/useLocalImageSrc'
import { useAppStore } from '@/store'
import { NativeChatMarkdown } from './NativeChatMarkdown'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'
import { useNativeChatLinkActions } from './use-native-chat-link-actions'
import { repoFixture, worktreeFixture } from './native-chat-workspace-test-fixtures'
import type * as TerminalFileOpenRouting from '@/components/terminal-pane/terminal-file-open-routing'
import { getDefaultSettings } from '../../../../shared/constants'

const mocks = vi.hoisted(() => ({
  readRuntimeFilePreview: vi.fn(),
  openDetectedFilePath: vi.fn()
}))

vi.mock('@/runtime/runtime-file-read-client', () => ({
  readRuntimeFilePreview: mocks.readRuntimeFilePreview
}))
vi.mock('@/components/terminal-pane/terminal-file-open-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof TerminalFileOpenRouting>()),
  openDetectedFilePath: mocks.openDetectedFilePath
}))

const localOwner = {
  fileLinkContext: {
    worktreeId: 'wt-1',
    worktreePath: '/repo/worktree',
    runtimeEnvironmentId: null,
    sourceTabId: 'tab-1'
  },
  runtimeContext: {
    target: { kind: 'local' as const },
    worktreeId: 'wt-1',
    worktreePath: '/repo/worktree',
    expectedExecutionHostId: 'local' as const
  },
  isVisible: true
}

type ImageOwner = NonNullable<
  ComponentProps<typeof NativeChatMarkdownImageOwnerContext.Provider>['value']
>

function Transcript({
  content = '| Screenshot |\n| --- |\n| ![Chart](screenshots/chart.png) |',
  owner = localOwner,
  growing = false,
  variant = 'document'
}: {
  content?: string
  owner?: ImageOwner
  growing?: boolean
  variant?: 'document' | 'compact'
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const { onLinkClick, linkActionRequest, closeLinkActions } = useNativeChatLinkActions(
    owner.fileLinkContext,
    rootRef,
    { sessionId: 'session-1', isVisible: owner.isVisible }
  )
  return (
    <TooltipProvider>
      <NativeChatMarkdownImageOwnerContext.Provider value={owner}>
        <div ref={rootRef}>
          <NativeChatMarkdown
            content={content}
            variant={variant}
            growing={growing}
            onLinkClick={onLinkClick}
            allowFileUriLinks
          />
          <LinkActionPopover request={linkActionRequest} onClose={closeLinkActions} />
        </div>
      </NativeChatMarkdownImageOwnerContext.Provider>
    </TooltipProvider>
  )
}

beforeEach(() => {
  resetLocalImageSrcStateForTests()
  const worktree = worktreeFixture('wt-1', '/repo/worktree', { hostId: 'local' })
  useAppStore.setState({
    ...useAppStore.getInitialState(),
    repos: [repoFixture()],
    worktreesByRepo: { repo: [worktree] },
    activeWorktreeId: 'wt-1',
    activeWorkspaceExecutionHostId: 'local'
  })
  let sequence = 0
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:image-${++sequence}`)
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  mocks.readRuntimeFilePreview.mockResolvedValue({
    content: 'AA==',
    isBinary: true,
    mimeType: 'image/png'
  })
})

afterEach(() => {
  cleanup()
  resetLocalImageSrcStateForTests()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('native chat Markdown image preview', () => {
  it.each(['actions', 'open', 'none'] as const)(
    'opens a table image immediately with %s link behavior and leaves text links unchanged',
    async (terminalLinkClickBehavior) => {
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), terminalLinkClickBehavior }
      })
      render(
        <Transcript
          content={'| Screenshot |\n| --- |\n| ![Chart](/tmp/chart.png) |\n\n[Source](src/app.ts)'}
        />
      )
      fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
      const dialog = screen.getByRole('dialog', { name: 'Chart' })
      expect(screen.queryByText('Open file')).not.toBeInTheDocument()
      expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
      expect(await within(dialog).findByRole('img', { name: 'Chart' })).toHaveAttribute(
        'src',
        'blob:image-1'
      )
      fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
      fireEvent.click(screen.getByRole('link', { name: 'Source' }))
      if (terminalLinkClickBehavior === 'actions') {
        expect(screen.getByText('Open file')).toBeInTheDocument()
      } else if (terminalLinkClickBehavior === 'open') {
        expect(mocks.openDetectedFilePath).toHaveBeenCalledWith(
          '/repo/worktree/src/app.ts',
          null,
          null,
          expect.anything()
        )
      } else {
        expect(screen.queryByText('Open file')).not.toBeInTheDocument()
        expect(mocks.openDetectedFilePath).not.toHaveBeenCalled()
      }
    }
  )

  it('uses one keyboard trigger for a linked image and returns focus after Escape', async () => {
    const user = userEvent.setup()
    const { container } = render(<Transcript content="[![Chart](chart.png)](details.md)" />)
    const trigger = screen.getByRole('button', { name: 'View image: Chart' })
    expect(container.querySelector('a button')).toBeNull()
    await screen.findByRole('img', { name: 'Chart' })
    trigger.focus()
    expect(trigger).toHaveFocus()
    await user.keyboard(' ')
    expect(screen.getByRole('dialog', { name: 'Chart' })).toHaveFocus()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(trigger).toHaveFocus()
  })

  it('keeps a streamed image dialog mounted when later prose arrives', async () => {
    const content = '![Chart](data:image/png;base64,AA==)\n\n'
    const { rerender } = render(<Transcript content={content} growing />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    const dialog = screen.getByRole('dialog', { name: 'Chart' })
    rerender(<Transcript content={`${content}More words`} growing />)
    expect(screen.getByRole('dialog', { name: 'Chart' })).toBe(dialog)
  })

  it('keeps linked-image caption actions separate from preview and preserves the context-menu target', () => {
    const { container } = render(<Transcript content="[caption ![Chart](chart.png)](details.md)" />)
    expect(container.querySelector('a button')).toBeNull()
    const trigger = screen.getByRole('button', { name: 'View image: Chart' })
    expect(trigger.closest('[data-native-chat-link-href]')).toHaveAttribute(
      'data-native-chat-link-href',
      'details.md'
    )
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog', { name: 'Chart' })).toBeInTheDocument()
    expect(screen.queryByText('Open file')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    fireEvent.click(screen.getByRole('link', { name: 'caption' }))
    expect(screen.getByText('/repo/worktree/details.md')).toBeInTheDocument()
  })

  it.each([
    ['Mac', { metaKey: true }],
    ['Linux', { ctrlKey: true }],
    ['Windows', { ctrlKey: true, shiftKey: true }]
  ] as const)('preserves %s modified image actions', (platform, modifiers) => {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(platform)
    render(<Transcript content="![Chart](chart.png)" />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }), modifiers)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.openDetectedFilePath).toHaveBeenCalledExactlyOnceWith(
      '/repo/worktree/chart.png',
      null,
      null,
      expect.objectContaining({ openWithSystemDefault: 'shiftKey' in modifiers })
    )
  })

  it('uses the host-qualified directory for relative image bytes and file actions', async () => {
    const user = userEvent.setup()
    const owner: ImageOwner = {
      ...localOwner,
      runtimeContext: {
        ...localOwner.runtimeContext,
        target: { kind: 'environment', environmentId: 'remote-a' },
        worktreePath: '/remote/chat'
      }
    }
    render(<Transcript owner={owner} content="![Chart](chart.png)" />)
    await user.click(screen.getByRole('button', { name: 'View image: Chart' }))
    expect(await within(screen.getByRole('dialog')).findByRole('img')).toHaveAttribute(
      'src',
      'blob:image-1'
    )
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'environment', environmentId: 'remote-a' } }),
      '/remote/chat/chart.png',
      { kind: 'chat-image' }
    )
    await user.click(screen.getByRole('button', { name: 'File actions' }))
    await user.click(screen.getByRole('menuitem', { name: 'Open file' }))
    expect(mocks.openDetectedFilePath).toHaveBeenCalledExactlyOnceWith(
      '/remote/chat/chart.png',
      null,
      null,
      expect.objectContaining({ worktreePath: '/remote/chat', runtimeEnvironmentId: 'remote-a' })
    )
  })

  it('retains a closable unavailable preview after image decoding fails', async () => {
    render(<Transcript content="![Chart](chart.png)" />)
    await screen.findByRole('img', { name: 'Chart' })
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    const dialog = screen.getByRole('dialog')
    fireEvent.error(within(dialog).getByRole('img'))
    expect(within(dialog).getByRole('status')).toHaveTextContent('Preview unavailable')
    expect(within(dialog).getByRole('button', { name: 'File actions' })).toBeInTheDocument()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('dismisses the nested file menu before the dialog and runs an action after preview closes', async () => {
    const user = userEvent.setup()
    render(<Transcript />)
    await user.click(screen.getByRole('button', { name: 'View image: Chart' }))
    const trigger = screen.getByRole('button', { name: 'File actions' })
    await user.click(trigger)
    expect(screen.getByRole('menuitem', { name: 'Open file' })).toBeInTheDocument()
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Chart' })).toBeInTheDocument()
    expect(trigger).toHaveFocus()
    await user.click(trigger)
    mocks.openDetectedFilePath.mockImplementationOnce(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    await user.click(screen.getByRole('menuitem', { name: 'Open file' }))
    expect(mocks.openDetectedFilePath).toHaveBeenCalledExactlyOnceWith(
      '/repo/worktree/screenshots/chart.png',
      null,
      null,
      expect.objectContaining({ worktreeId: 'wt-1', sourceTabId: 'tab-1' })
    )
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('keeps Close usable while the file menu is open', async () => {
    const user = userEvent.setup()
    render(<Transcript />)
    await user.click(screen.getByRole('button', { name: 'View image: Chart' }))
    await user.click(screen.getByRole('button', { name: 'File actions' }))
    await user.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('opens while a remote read is pending and clears image bytes and actions on owner loss', async () => {
    const pendingRead = Promise.withResolvers<{
      content: string
      isBinary: boolean
      mimeType: string
    }>()
    mocks.readRuntimeFilePreview.mockReturnValueOnce(pendingRead.promise)
    const owner: ImageOwner = {
      ...localOwner,
      runtimeContext: {
        ...localOwner.runtimeContext,
        target: { kind: 'environment', environmentId: 'remote-a' }
      },
      fileLinkContext: { ...localOwner.fileLinkContext, runtimeEnvironmentId: 'remote-a' }
    }
    const { rerender } = render(<Transcript owner={owner} />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    expect(screen.getByRole('dialog', { name: 'Chart' })).toBeInTheDocument()
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledWith(
      expect.objectContaining({ target: { kind: 'environment', environmentId: 'remote-a' } }),
      '/repo/worktree/screenshots/chart.png',
      { kind: 'chat-image' }
    )
    rerender(<Transcript owner={{ ...owner, runtimeContext: null }} />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    expect(screen.queryByRole('button', { name: 'File actions' })).toBeNull()
    await act(async () =>
      pendingRead.resolve({ content: 'AA==', isBinary: true, mimeType: 'image/png' })
    )
    expect(within(screen.getByRole('dialog')).queryByRole('img')).toBeNull()
    expect(mocks.readRuntimeFilePreview).toHaveBeenCalledOnce()
  })

  it('closes the preview when the owning chat becomes hidden', () => {
    const { rerender } = render(<Transcript />)
    fireEvent.click(screen.getByRole('button', { name: 'View image: Chart' }))
    rerender(<Transcript owner={{ ...localOwner, isVisible: false }} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    rerender(<Transcript />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('retains compact trust checks and GitHub attachment fallback', () => {
    const { rerender } = render(
      <Transcript variant="compact" content="![Chart](https://example.com/chart.png)" />
    )
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'Chart' })).toBeInTheDocument()
    rerender(
      <Transcript content="![Attachment](https://github.com/user-attachments/assets/secret)" />
    )
    fireEvent.error(screen.getByRole('img', { name: 'Attachment' }))
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.getByRole('link', { name: 'Attachment' })).toHaveAttribute(
      'href',
      'https://github.com/user-attachments/assets/secret'
    )
  })
})
