import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const noop = vi.fn()
  const contextMenuCalls: unknown[] = []
  const storeState = {
    activeWorktreeId: 'wt-1',
    pendingStartupByTabId: {},
    pendingSetupSplitByTabId: {},
    pendingIssueCommandSplitByTabId: {},
    terminalLayoutsByTabId: {},
    pendingCodexPaneRestartIds: {},
    repos: {},
    worktreesByRepo: {
      repo1: [{ id: 'wt-1', path: '/repo', repoId: 'repo1' }]
    },
    settings: {
      terminalAppearanceMode: 'dark',
      terminalRightClickToPaste: true,
      terminalMacOptionAsAlt: 'auto',
      terminalQuickCommands: [
        { label: 'List', command: 'ls -la' },
        { label: ' ', command: 'ignored' }
      ],
      activeRuntimeEnvironmentId: null
    },
    setTabPaneExpanded: noop,
    setTabCanExpandPane: noop,
    suppressPtyExit: noop,
    consumePendingCodexPaneRestart: vi.fn(() => false),
    clearCodexRestartNotice: noop,
    setTabLayout: noop,
    updateTabTitle: noop,
    setRuntimePaneTitle: noop,
    clearRuntimePaneTitle: noop,
    updateTabPtyId: noop,
    clearTabPtyId: noop,
    markWorktreeUnread: noop,
    markTerminalTabUnread: noop,
    clearWorktreeUnread: noop,
    clearTerminalTabUnread: noop,
    setCacheTimerStartedAt: noop,
    consumeSuppressedPtyExit: vi.fn(() => false),
    consumeTabStartupCommand: noop,
    consumeTabSetupSplit: noop,
    consumeTabIssueCommandSplit: noop,
    dropAgentStatus: noop
  }

  return { contextMenuCalls, noop, storeState }
})

vi.mock('../../store', () => {
  const useAppStore = vi.fn((selector: (state: typeof mocks.storeState) => unknown) =>
    selector(mocks.storeState)
  )
  Object.assign(useAppStore, { getState: () => mocks.storeState })
  return { useAppStore }
})

vi.mock('@/lib/terminal-theme', () => ({
  DEFAULT_TERMINAL_DIVIDER_DARK: '#333333',
  normalizeColor: vi.fn((value: string | undefined, fallback: string) => value ?? fallback),
  resolveEffectiveTerminalAppearance: vi.fn(() => ({ dividerColor: '#444444' }))
}))

vi.mock('@/components/TerminalSearch', () => ({
  default: () => <div data-testid="terminal-search" />
}))

vi.mock('./pane-helpers', () => ({
  fitPanes: vi.fn(),
  isWindowsUserAgent: vi.fn(() => false),
  shellEscapePath: vi.fn((path: string) => path)
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('./terminal-drop-handler', () => ({
  resolveTerminalDropTargetShell: vi.fn(() => 'posix')
}))

vi.mock('./layout-serialization', () => ({
  EMPTY_LAYOUT: { root: null },
  paneLeafId: vi.fn((paneId: number) => `pane-${paneId}`),
  serializeTerminalLayout: vi.fn(() => ({ root: null }))
}))

vi.mock('./expand-collapse', () => ({
  applyExpandedLayoutTo: vi.fn(() => false),
  createExpandCollapseActions: vi.fn(() => ({
    setExpandedPane: vi.fn(),
    restoreExpandedLayout: vi.fn(),
    refreshPaneSizes: vi.fn(),
    syncExpandedLayout: vi.fn(),
    toggleExpandPane: vi.fn()
  })),
  restoreExpandedLayoutFrom: vi.fn()
}))

vi.mock('./keyboard-handlers', () => ({
  useTerminalKeyboardShortcuts: vi.fn()
}))

vi.mock('@/lib/keyboard-layout/use-effective-mac-option-as-alt', () => ({
  useEffectiveMacOptionAsAlt: vi.fn(() => false)
}))

vi.mock('./useTerminalFontZoom', () => ({
  useTerminalFontZoom: vi.fn()
}))

vi.mock('./CloseTerminalDialog', () => ({
  default: ({ open }: { open: boolean }) => (
    <div data-testid="close-terminal-dialog" data-open={String(open)} />
  )
}))

vi.mock('./TerminalErrorToast', () => ({
  TerminalErrorToast: ({ error }: { error: string }) => (
    <div data-testid="terminal-error">{error}</div>
  )
}))

vi.mock('./TerminalContextMenu', () => ({
  default: ({ quickCommands }: { quickCommands: unknown[] }) => (
    <div data-testid="terminal-context-menu" data-commands={quickCommands.length} />
  )
}))

vi.mock('./use-system-prefers-dark', () => ({
  useSystemPrefersDark: vi.fn(() => true)
}))

vi.mock('./use-terminal-pane-global-effects', () => ({
  useTerminalPaneGlobalEffects: vi.fn()
}))

vi.mock('./use-terminal-pane-lifecycle', () => ({
  useTerminalPaneLifecycle: vi.fn()
}))

vi.mock('./use-terminal-pane-context-menu', () => ({
  useTerminalPaneContextMenu: vi.fn((args: unknown) => {
    mocks.contextMenuCalls.push(args)
    return {
      open: false,
      setOpen: vi.fn(),
      point: null,
      menuOpenedAtRef: { current: 0 },
      paneCount: 1,
      menuPaneId: null,
      onContextMenuCapture: vi.fn(),
      onCopy: vi.fn(),
      onPaste: vi.fn(),
      onSplitRight: vi.fn(),
      onSplitDown: vi.fn(),
      onClosePane: vi.fn(),
      onClearScreen: vi.fn(),
      onQuickCommand: vi.fn(),
      onToggleExpand: vi.fn(),
      onSetTitle: vi.fn()
    }
  })
}))

vi.mock('./use-notification-dispatch', () => ({
  useNotificationDispatch: vi.fn(() => vi.fn())
}))

vi.mock('./pty-connection', () => ({
  connectPanePty: vi.fn()
}))

vi.mock('../../../../shared/workspace-session-terminal-buffers', () => ({
  shouldPreserveTerminalScrollbackBuffers: vi.fn(() => true)
}))

vi.mock('@/lib/pane-manager/mobile-fit-overrides', () => ({
  getFitOverrideForPty: vi.fn(() => null),
  getPaneIdsForPty: vi.fn(() => []),
  onOverrideChange: vi.fn(() => vi.fn())
}))

vi.mock('@/lib/pane-manager/mobile-driver-state', () => ({
  getDriverForPty: vi.fn(() => ({ kind: 'none' })),
  onDriverChange: vi.fn(() => vi.fn())
}))

vi.mock('@/lib/pane-manager/pane-tree-ops', () => ({
  safeFit: vi.fn()
}))

vi.mock('./terminal-shutdown-layout-capture', () => ({
  captureTerminalShutdownLayout: vi.fn(() => ({ root: null }))
}))

vi.mock('@/runtime/runtime-terminal-inspection', () => ({
  inspectRuntimeTerminalProcess: vi.fn(() => Promise.resolve({ hasChildProcesses: false }))
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(() => Promise.resolve())
}))

vi.mock('@/runtime/runtime-terminal-stream', () => ({
  getRemoteRuntimePtyEnvironmentId: vi.fn(() => null),
  getRemoteRuntimeTerminalHandle: vi.fn(() => null)
}))

vi.mock('./shutdown-buffer-captures', () => ({
  shutdownBufferCaptures: new Map()
}))

vi.mock('./merge-captured-leaf-state', () => ({
  mergeCapturedLeafState: vi.fn(({ prior, fresh }) => ({ ...prior, ...fresh }))
}))

import TerminalPane from './TerminalPane'

describe('TerminalPane initial render', () => {
  beforeEach(() => {
    mocks.contextMenuCalls.length = 0
    vi.clearAllMocks()
  })

  it('renders a visible terminal host and filters blank quick commands', () => {
    const html = renderToStaticMarkup(
      <TerminalPane
        tabId="tab-1"
        worktreeId="wt-1"
        cwd="/repo"
        isActive
        onPtyExit={vi.fn()}
        onCloseTab={vi.fn()}
      />
    )

    expect(html).toContain('data-native-file-drop-target="terminal"')
    expect(html).toContain('data-terminal-tab-id="tab-1"')
    expect(html).toContain('display:flex')
    expect(html).toContain('data-testid="terminal-context-menu"')
    expect(html).toContain('data-commands="1"')
    expect(mocks.contextMenuCalls).toHaveLength(1)
    expect(mocks.contextMenuCalls[0]).toMatchObject({ rightClickToPaste: false })
  })

  it('keeps hidden terminal panes mounted but display-none', () => {
    const html = renderToStaticMarkup(
      <TerminalPane
        tabId="tab-hidden"
        worktreeId="wt-1"
        isActive={false}
        isVisible={false}
        onPtyExit={vi.fn()}
        onCloseTab={vi.fn()}
      />
    )

    expect(html).toContain('data-terminal-tab-id="tab-hidden"')
    expect(html).toContain('display:none')
    expect(html).toContain('data-open="false"')
  })
})
