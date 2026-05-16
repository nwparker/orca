// @ts-nocheck -- Structural React-element test uses intentionally partial child props.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PtyManagementSession } from '../../../../preload/api-types'

const reactRuntime = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  refIndex: 0,
  stateIndex: 0,
  states: [] as unknown[],
  setters: [] as ReturnType<typeof vi.fn>[]
}))

const storeMocks = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(),
  activateTabAndFocusPane: vi.fn(),
  closeSettingsPage: vi.fn(),
  setActiveView: vi.fn(),
  state: {
    settings: { activeRuntimeEnvironmentId: null as string | null },
    tabsByWorktree: {
      'repo-1::/repo/worktree': [{ id: 'tab-1' }]
    },
    ptyIdsByTabId: {
      'tab-1': ['pty-1']
    },
    setActiveView: vi.fn(),
    closeSettingsPage: vi.fn()
  }
}))

const daemonMocks = vi.hoisted(() => ({
  actions: {
    busyKind: null as 'killAll' | 'restart' | null,
    isBusy: false,
    setPending: vi.fn()
  },
  callbacks: null as null | Record<string, () => void>
}))

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn()
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual needs the inline import.
  return {
    ...actual,
    useCallback: <T,>(callback: T) => callback,
    useEffect: () => {},
    useMemo: <T,>(factory: () => T) => factory(),
    useRef: (initial: unknown) => {
      const index = reactRuntime.refIndex++
      reactRuntime.refs[index] ??= { current: initial }
      return reactRuntime.refs[index]
    },
    useState: (initial: unknown) => {
      const index = reactRuntime.stateIndex++
      if (!(index in reactRuntime.states)) {
        reactRuntime.states[index] = initial
      }
      const setter = vi.fn((next: unknown) => {
        reactRuntime.states[index] =
          typeof next === 'function'
            ? (next as (previous: unknown) => unknown)(reactRuntime.states[index])
            : next
      })
      reactRuntime.setters[index] = setter
      return [reactRuntime.states[index], setter]
    }
  }
})

vi.mock('lucide-react', () => ({
  LoaderCircle: function LoaderCircle() {
    return null
  },
  RefreshCw: function RefreshCw() {
    return null
  },
  RotateCw: function RotateCw() {
    return null
  },
  Trash2: function Trash2() {
    return null
  },
  X: function X() {
    return null
  }
}))

vi.mock('sonner', () => ({
  toast: toastMocks
}))

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: typeof storeMocks.state) => unknown) =>
    selector({
      ...storeMocks.state,
      setActiveView: storeMocks.setActiveView,
      closeSettingsPage: storeMocks.closeSettingsPage
    })
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorktree: storeMocks.activateAndRevealWorktree
}))

vi.mock('@/lib/activate-tab-and-focus-pane', () => ({
  activateTabAndFocusPane: storeMocks.activateTabAndFocusPane
}))

vi.mock('../shared/useDaemonActions', () => ({
  DaemonActionDialog: function DaemonActionDialog(props: Record<string, unknown>) {
    return { type: 'DaemonActionDialog', props }
  },
  useDaemonActions: vi.fn((callbacks: Record<string, () => void>) => {
    daemonMocks.callbacks = callbacks
    return daemonMocks.actions
  })
}))

vi.mock('../ui/button', () => ({
  Button: function Button(props: Record<string, unknown>) {
    return { type: 'Button', props }
  }
}))

vi.mock('../ui/dialog', () => ({
  Dialog: function Dialog(props: Record<string, unknown>) {
    return { type: 'Dialog', props }
  },
  DialogContent: function DialogContent(props: Record<string, unknown>) {
    return { type: 'DialogContent', props }
  },
  DialogDescription: function DialogDescription(props: Record<string, unknown>) {
    return { type: 'DialogDescription', props }
  },
  DialogFooter: function DialogFooter(props: Record<string, unknown>) {
    return { type: 'DialogFooter', props }
  },
  DialogHeader: function DialogHeader(props: Record<string, unknown>) {
    return { type: 'DialogHeader', props }
  },
  DialogTitle: function DialogTitle(props: Record<string, unknown>) {
    return { type: 'DialogTitle', props }
  }
}))

vi.mock('../ui/tooltip', () => ({
  Tooltip: function Tooltip(props: Record<string, unknown>) {
    return { type: 'Tooltip', props }
  },
  TooltipContent: function TooltipContent(props: Record<string, unknown>) {
    return { type: 'TooltipContent', props }
  },
  TooltipTrigger: function TooltipTrigger(props: Record<string, unknown>) {
    return { type: 'TooltipTrigger', props }
  }
}))

vi.mock('./SearchableSetting', () => ({
  SearchableSetting: function SearchableSetting(props: Record<string, unknown>) {
    return { type: 'SearchableSetting', props }
  }
}))

type ElementLike = {
  type: unknown
  props: Record<string, unknown>
}

const listSessions = vi.fn()
const killOne = vi.fn()

function resetReactRuntime(states: unknown[]): void {
  reactRuntime.refs = []
  reactRuntime.refIndex = 0
  reactRuntime.stateIndex = 0
  reactRuntime.states = states
  reactRuntime.setters = []
}

function makeSession(overrides: Partial<PtyManagementSession> = {}): PtyManagementSession {
  return {
    sessionId: 'pty-1',
    state: 'running',
    shellState: 'ready',
    isAlive: true,
    pid: 1234,
    cwd: '/Users/mona/orca/worktree',
    cols: 120,
    rows: 40,
    createdAt: 1,
    protocolVersion: 1,
    ...overrides
  }
}

async function renderManageSessionsSection(states: unknown[] = []) {
  resetReactRuntime(states)
  const module = await import('./ManageSessionsSection')
  return module.ManageSessionsSection()
}

function typeName(node: ElementLike): string {
  if (typeof node.type === 'string') {
    return node.type
  }
  if (typeof node.type === 'function') {
    return node.type.name
  }
  return String(node.type)
}

function visit(node: unknown, callback: (element: ElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      visit(child, callback)
    }
    return
  }
  const element = node as ElementLike
  callback(element)
  if (element.props && 'children' in element.props) {
    visit(element.props.children, callback)
  }
}

function findByType(node: unknown, expectedType: string): ElementLike[] {
  const matches: ElementLike[] = []
  visit(node, (element) => {
    if (typeName(element) === expectedType) {
      matches.push(element)
    }
  })
  return matches
}

function findButtonByLabel(node: unknown, label: string): ElementLike {
  const button = findByType(node, 'Button').find((element) => element.props['aria-label'] === label)
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

function textContent(node: unknown): string {
  if (node == null) {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(textContent).join('')
  }
  const element = node as ElementLike
  return textContent(element.props?.children)
}

async function flushAsyncCallbacks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  vi.clearAllMocks()
  daemonMocks.actions.busyKind = null
  daemonMocks.actions.isBusy = false
  daemonMocks.callbacks = null
  storeMocks.state.settings.activeRuntimeEnvironmentId = null
  listSessions.mockResolvedValue({ sessions: [] })
  killOne.mockResolvedValue({ success: true })
  vi.stubGlobal('window', {
    api: {
      pty: {
        management: {
          listSessions,
          killOne
        }
      }
    }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ManageSessionsSection', () => {
  it('renders the remote-runtime unavailable branch', async () => {
    storeMocks.state.settings.activeRuntimeEnvironmentId = 'env-1'

    const tree = await renderManageSessionsSection([[], false, true, null, null])

    expect(textContent(tree)).toContain(
      'Session management is unavailable while a remote runtime server is active.'
    )
    expect(textContent(tree)).toContain('Switch back to the local runtime')
  })

  it('renders sessions and wires row, refresh, kill-all, restart, and kill-one actions', async () => {
    const sessions = [
      makeSession(),
      makeSession({
        sessionId: 'repo-1::C:\\repo\\feature@@hash',
        cwd: null,
        isAlive: false,
        shellState: 'pending',
        state: 'spawning'
      })
    ]

    const tree = await renderManageSessionsSection([sessions, false, true, null, null])

    expect(textContent(tree)).toContain('Sessions(2)')
    expect(textContent(tree)).toContain('orca/worktree')
    expect(textContent(tree)).toContain('repo\\feature')

    const rows = findByType(tree, 'tr')
    rows[0]?.props.onClick?.()
    expect(storeMocks.activateAndRevealWorktree).toHaveBeenCalledWith('repo-1::/repo/worktree')
    expect(storeMocks.setActiveView).toHaveBeenCalledWith('terminal')
    expect(storeMocks.activateTabAndFocusPane).toHaveBeenCalledWith('tab-1', null)
    expect(storeMocks.closeSettingsPage).toHaveBeenCalled()
    expect(rows[0]?.props['aria-label']).toBe('Go to terminal orca/worktree')
    expect(rows[1]?.props.onClick).toBeUndefined()

    findButtonByLabel(tree, 'Refresh').props.onClick?.()
    expect(listSessions).toHaveBeenCalled()

    findButtonByLabel(tree, 'Kill all sessions').props.onClick?.()
    expect(daemonMocks.actions.setPending).toHaveBeenCalledWith('killAll')

    findButtonByLabel(tree, 'Restart daemon').props.onClick?.()
    expect(daemonMocks.actions.setPending).toHaveBeenCalledWith('restart')

    const stopPropagation = vi.fn()
    findButtonByLabel(tree, 'Kill session pty-1').props.onClick?.({ stopPropagation })

    expect(stopPropagation).toHaveBeenCalled()
    expect(reactRuntime.states[3]).toEqual({ kind: 'killOne', session: sessions[0] })
  })

  it('runs daemon action lifecycle callbacks with optimistic rollback', async () => {
    const sessions = [makeSession()]
    await renderManageSessionsSection([sessions, false, true, null, null])

    daemonMocks.callbacks?.onKillAllStart()
    expect(reactRuntime.states[0]).toEqual([])

    daemonMocks.callbacks?.onKillAllError()
    expect(reactRuntime.states[0]).toBe(sessions)

    daemonMocks.callbacks?.onKillAllSettled()
    daemonMocks.callbacks?.onRestartSettled()
    await Promise.resolve()

    expect(listSessions).toHaveBeenCalledTimes(2)
  })

  it('confirms and runs a single-session kill', async () => {
    const session = makeSession()
    const tree = await renderManageSessionsSection([
      [session],
      false,
      true,
      { kind: 'killOne', session },
      null
    ])
    const dialog = findByType(tree, 'Dialog')[0]
    expect(dialog?.props.open).toBe(true)

    const confirmButton = findByType(tree, 'Button').find(
      (element) => textContent(element) === 'Kill session'
    )
    confirmButton?.props.onClick?.()
    await flushAsyncCallbacks()

    expect(killOne).toHaveBeenCalledWith({ sessionId: 'pty-1' })
    expect(toastMocks.success).toHaveBeenCalledWith('Killed session.')
    expect(reactRuntime.states[3]).toBeNull()
    expect(reactRuntime.states[4]).toBeNull()
  })

  it('keeps the confirm dialog open while busy and blocks pointer/escape dismissal', async () => {
    daemonMocks.actions.isBusy = true
    const session = makeSession()
    const tree = await renderManageSessionsSection([
      [session],
      false,
      true,
      { kind: 'killOne', session },
      'killOne'
    ])

    findByType(tree, 'Dialog')[0]?.props.onOpenChange?.(false)
    expect(reactRuntime.states[3]).toEqual({ kind: 'killOne', session })

    const preventDefault = vi.fn()
    const content = findByType(tree, 'DialogContent')[0]
    content?.props.onPointerDownOutside?.({ preventDefault })
    content?.props.onEscapeKeyDown?.({ preventDefault })

    expect(preventDefault).toHaveBeenCalledTimes(2)
    expect(textContent(tree)).toContain('Killing')
  })
})
