/* eslint-disable max-lines */
import { createStore, type StoreApi } from 'zustand/vanilla'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../../shared/constants'
import type { PersistedUIState, UpdateStatus } from '../../../../shared/types'
import { createUISlice } from './ui'
import { createWorktreeNavHistorySlice } from './worktree-nav-history'
import type { AppState } from '../types'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function createUIStore(): StoreApi<AppState> {
  // Only the UI slice, repo ids, and right sidebar width fallback are needed
  // for persisted UI hydration tests. The worktree-nav-history slice is also
  // included because openTaskPage records a Tasks visit via recordViewVisit.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return createStore<any>()((...args: any[]) => ({
    repos: [],
    rightSidebarWidth: 280,
    ...createWorktreeNavHistorySlice(...(args as Parameters<typeof createWorktreeNavHistorySlice>)),
    ...createUISlice(...(args as Parameters<typeof createUISlice>))
  })) as unknown as StoreApi<AppState>
}

function makePersistedUI(overrides: Partial<PersistedUIState> = {}): PersistedUIState {
  return {
    ...getDefaultUIState(),
    ...overrides
  }
}

describe('createUISlice hydratePersistedUI', () => {
  it('preserves the current right sidebar width when older persisted UI omits it', () => {
    const store = createUIStore()

    store.setState({ rightSidebarWidth: 360 })
    store.getState().hydratePersistedUI({
      ...makePersistedUI(),
      rightSidebarWidth: undefined as unknown as number
    })

    expect(store.getState().rightSidebarWidth).toBe(360)
  })

  it('clamps persisted sidebar widths into the supported range', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: 100,
        rightSidebarWidth: 100
      })
    )

    expect(store.getState().sidebarWidth).toBe(220)
    expect(store.getState().rightSidebarWidth).toBe(220)
  })

  it('preserves right sidebar widths above the former 500px cap', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: 260,
        rightSidebarWidth: 900
      })
    )

    // Left sidebar stays capped; right sidebar now allows wide drag targets
    // so long file names remain readable.
    expect(store.getState().sidebarWidth).toBe(260)
    expect(store.getState().rightSidebarWidth).toBe(900)
  })

  it('falls back to existing sidebar widths when persisted values are not finite', () => {
    const store = createUIStore()

    store.getState().setSidebarWidth(320)
    store.setState({ rightSidebarWidth: 360 })

    store.getState().hydratePersistedUI(
      makePersistedUI({
        sidebarWidth: Number.NaN,
        rightSidebarWidth: Number.POSITIVE_INFINITY
      })
    )

    expect(store.getState().sidebarWidth).toBe(320)
    expect(store.getState().rightSidebarWidth).toBe(360)
  })

  it('restores the active-only filter from persisted UI state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        showActiveOnly: true
      })
    )

    expect(store.getState().showActiveOnly).toBe(true)
  })

  it('restores the hide-default-branch filter from persisted UI state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        hideDefaultBranchWorkspace: true
      })
    )

    expect(store.getState().hideDefaultBranchWorkspace).toBe(true)
  })

  it('restores compact workspace board mode only from an explicit true', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        workspaceBoardCompact: true
      })
    )
    expect(store.getState().workspaceBoardCompact).toBe(true)

    store.getState().hydratePersistedUI(
      makePersistedUI({
        workspaceBoardCompact: 'yes' as unknown as boolean
      })
    )
    expect(store.getState().workspaceBoardCompact).toBe(false)
  })

  it('hydrates a valid Kagi session link', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        browserKagiSessionLink: 'https://kagi.com/search?token=secret&q=%s'
      })
    )

    expect(store.getState().browserKagiSessionLink).toBe('https://kagi.com/search?token=secret')
  })

  it('drops an invalid Kagi session link during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        browserKagiSessionLink: 'https://example.com/search?token=secret'
      })
    )

    expect(store.getState().browserKagiSessionLink).toBeNull()
  })

  it('hydrates legacy sidekick persisted keys into pet state', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        petVisible: undefined,
        petId: undefined,
        petSize: undefined,
        customPets: undefined,
        sidekickVisible: false,
        sidekickId: 'custom-pet',
        sidekickSize: 240,
        customSidekicks: [
          {
            id: 'custom-pet',
            label: 'Legacy pet',
            fileName: 'custom-pet.webp',
            mimeType: 'image/webp',
            kind: 'image'
          }
        ]
      })
    )

    expect(store.getState().petVisible).toBe(false)
    expect(store.getState().petId).toBe('custom-pet')
    expect(store.getState().petSize).toBe(240)
    expect(store.getState().customPets).toEqual([
      {
        id: 'custom-pet',
        label: 'Legacy pet',
        fileName: 'custom-pet.webp',
        mimeType: 'image/webp',
        kind: 'image'
      }
    ])
  })

  it('sanitizes task resume state field-by-field during hydration', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        taskResumeState: {
          githubMode: 'project',
          githubItemsPreset: 'invalid',
          githubItemsQuery: 42,
          linearPreset: 'completed',
          linearQuery: 'label:bug'
        } as unknown as PersistedUIState['taskResumeState']
      })
    )

    expect(store.getState().taskResumeState).toEqual({
      githubMode: 'project',
      linearPreset: 'completed',
      linearQuery: 'label:bug'
    })
  })

  it('restores acknowledgedAgentsByPaneKey from persisted UI state', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: { 'tab-a:0': now, 'tab-b:1': now - 5_000 }
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-a:0': now,
        'tab-b:1': now - 5_000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('falls back to an empty ack map when persisted UI omits acknowledgedAgentsByPaneKey', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(makePersistedUI())

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is null', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey:
          null as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is a string', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey:
          'oops' as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('falls back to an empty ack map when persisted acknowledgedAgentsByPaneKey is an array', () => {
    const store = createUIStore()

    store.getState().hydratePersistedUI(
      makePersistedUI({
        acknowledgedAgentsByPaneKey: [
          'a',
          'b'
        ] as unknown as PersistedUIState['acknowledgedAgentsByPaneKey']
      })
    )

    expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({})
  })

  it('drops non-number / non-finite / non-positive entries from acknowledgedAgentsByPaneKey', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: {
            'tab-a:0': now,
            'tab-b:1': now - 1000,
            'tab-c:2': 'not-a-number',
            'tab-d:3': Number.NaN,
            'tab-e:4': Number.POSITIVE_INFINITY,
            'tab-f:5': -1
          } as unknown as Record<string, number>
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-a:0': now,
        'tab-b:1': now - 1000
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('prunes acknowledgedAgentsByPaneKey entries older than the 7-day TTL during hydration', () => {
    // HYDRATE_MAX_AGE_MS lives in src/renderer/src/store/slices/ui.ts and matches
    // the constant in src/main/agent-hooks/server.ts.
    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: {
            'tab-recent:0': now,
            'tab-old:1': now - SEVEN_DAYS_MS - 1
          }
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-recent:0': now
      })
    } finally {
      // The shared afterEach restores mocks/globals but not timers, so clean up
      // here to avoid leaking fake timers into subsequent tests.
      vi.useRealTimers()
    }
  })

  it('drops prototype-pollution keys from acknowledgedAgentsByPaneKey during hydration', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()
      const malicious: Record<string, number> = {}
      // Object.defineProperty so these land as own enumerable properties rather
      // than getting silently re-routed to Object.prototype by the JS engine.
      Object.defineProperty(malicious, '__proto__', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      Object.defineProperty(malicious, 'constructor', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      Object.defineProperty(malicious, 'prototype', {
        value: now,
        enumerable: true,
        configurable: true,
        writable: true
      })
      malicious['tab-safe:0'] = now

      store.getState().hydratePersistedUI(
        makePersistedUI({
          acknowledgedAgentsByPaneKey: malicious
        })
      )

      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-safe:0': now
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('merges and persists partial task resume updates', () => {
    const setUI = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { ui: { set: setUI } } })
    const store = createUIStore()

    store.setState({ taskResumeState: { githubMode: 'project', linearPreset: 'all' } })
    store.getState().setTaskResumeState({ githubItemsPreset: 'my-prs' })

    const expected = { githubMode: 'project', linearPreset: 'all', githubItemsPreset: 'my-prs' }
    expect(store.getState().taskResumeState).toEqual(expected)
    expect(setUI).toHaveBeenCalledWith({ taskResumeState: expected })
  })
})

describe('createUISlice settings navigation', () => {
  it('returns to the tasks page after visiting settings from an in-progress draft', () => {
    const store = createUIStore()

    store.getState().openTaskPage({ preselectedRepoId: 'repo-1' })
    store.getState().openSettingsPage()

    expect(store.getState().activeView).toBe('settings')
    expect(store.getState().previousViewBeforeSettings).toBe('tasks')

    store.getState().closeSettingsPage()

    expect(store.getState().activeView).toBe('tasks')
  })

  it('keeps the original return target when settings is reopened while already visible', () => {
    const store = createUIStore()

    store.getState().openTaskPage()
    store.getState().openSettingsPage()
    store.getState().openSettingsPage()

    expect(store.getState().previousViewBeforeSettings).toBe('tasks')

    store.getState().closeSettingsPage()

    expect(store.getState().activeView).toBe('tasks')
  })
})

describe('createUISlice feature tour nudge', () => {
  it('shows and dismisses the feature tour nudge', () => {
    const store = createUIStore()

    store.getState().showFeatureTourNudge()
    expect(store.getState().featureTourNudgeVisible).toBe(true)

    store.getState().dismissFeatureTourNudge()
    expect(store.getState().featureTourNudgeVisible).toBe(false)
  })

  it('keeps the nudge hidden while the full feature tour is open', () => {
    const store = createUIStore()

    store.getState().openModal('feature-wall')
    store.getState().showFeatureTourNudge()
    expect(store.getState().featureTourNudgeVisible).toBe(false)

    store.getState().closeModal()
    store.getState().showFeatureTourNudge()
    expect(store.getState().featureTourNudgeVisible).toBe(true)

    store.getState().openModal('feature-wall')
    expect(store.getState().featureTourNudgeVisible).toBe(false)
  })
})

describe('createUISlice space navigation', () => {
  it('returns to the tasks page after opening Space from an in-progress draft', () => {
    const store = createUIStore()

    store.getState().openTaskPage({ preselectedRepoId: 'repo-1' })
    store.getState().openSpacePage()

    expect(store.getState().activeView).toBe('space')
    expect(store.getState().previousViewBeforeSpace).toBe('tasks')

    store.getState().closeSpacePage()

    expect(store.getState().activeView).toBe('tasks')
  })

  it('keeps the original return target when Space is reopened while already visible', () => {
    const store = createUIStore()

    store.getState().openTaskPage()
    store.getState().openSpacePage()
    store.getState().openSpacePage()

    expect(store.getState().previousViewBeforeSpace).toBe('tasks')

    store.getState().closeSpacePage()

    expect(store.getState().activeView).toBe('tasks')
  })
})

describe('createUISlice action mutators', () => {
  function stubPersistence() {
    const setUI = vi.fn().mockResolvedValue(undefined)
    const deletePet = vi.fn().mockResolvedValue(undefined)
    const dismissNudge = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', {
      api: {
        pet: { delete: deletePet },
        ui: { set: setUI },
        updater: { dismissNudge }
      }
    })
    return { deletePet, dismissNudge, setUI }
  }

  it('acknowledges and unacknowledges agent pane keys without rewriting no-ops', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)

    try {
      const store = createUIStore()
      const beforeEmptyAck = store.getState()
      store.getState().acknowledgeAgents([])
      expect(store.getState()).toBe(beforeEmptyAck)

      store.getState().acknowledgeAgents(['tab-1:1', 'tab-2:1'])
      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({
        'tab-1:1': now,
        'tab-2:1': now
      })

      const beforeDuplicateAck = store.getState()
      store.getState().acknowledgeAgents(['tab-1:1'])
      expect(store.getState()).toBe(beforeDuplicateAck)

      store.getState().unacknowledgeAgents(['missing', 'tab-1:1'])
      expect(store.getState().acknowledgedAgentsByPaneKey).toEqual({ 'tab-2:1': now })

      const beforeEmptyUnack = store.getState()
      store.getState().unacknowledgeAgents([])
      expect(store.getState()).toBe(beforeEmptyUnack)
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens task page and prefetches the matching GitHub work-item query', () => {
    stubPersistence()
    const store = createUIStore()
    const prefetchWorkItems = vi.fn()
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0
        }
      ],
      settings: {
        defaultRepoSelection: ['repo1'],
        defaultTaskSource: 'github',
        defaultTaskViewPreset: 'my-prs'
      },
      prefetchWorkItems,
      taskResumeState: { githubMode: 'items' }
    } as unknown as Partial<AppState>)

    store.getState().openTaskPage({ preselectedRepoId: 'repo1' })

    expect(store.getState().activeView).toBe('tasks')
    expect(store.getState().taskPageData).toEqual({ preselectedRepoId: 'repo1' })
    expect(prefetchWorkItems).toHaveBeenCalledWith(
      'repo1',
      '/repo1',
      expect.any(Number),
      'author:@me is:pr is:open'
    )

    store.setState({
      taskResumeState: {
        githubMode: 'items',
        githubItemsPreset: null,
        githubItemsQuery: '  label:bug  '
      }
    } as Partial<AppState>)
    store.getState().openTaskPage()

    expect(prefetchWorkItems).toHaveBeenLastCalledWith(
      'repo1',
      '/repo1',
      expect.any(Number),
      'label:bug'
    )
  })

  it('updates navigation, modal, grouping, filter, status-bar, and workspace-board state', () => {
    const { setUI } = stubPersistence()
    const store = createUIStore()

    store.getState().openActivityPage()
    expect(store.getState().activeView).toBe('activity')
    store.getState().closeActivityPage()
    expect(store.getState().activeView).toBe('terminal')

    store.getState().setSelectedAutomationId('auto-1')
    store.getState().openAutomationsPage()
    expect(store.getState().activeView).toBe('automations')
    expect(store.getState().selectedAutomationId).toBe('auto-1')
    store.getState().closeAutomationsPage()
    expect(store.getState().activeView).toBe('terminal')

    store.getState().openSettingsTarget({ pane: 'repo', repoId: 'repo1', sectionId: 'hooks' })
    expect(store.getState().settingsNavigationTarget).toEqual({
      pane: 'repo',
      repoId: 'repo1',
      sectionId: 'hooks'
    })
    store.getState().clearSettingsTarget()
    expect(store.getState().settingsNavigationTarget).toBeNull()

    store.getState().setNewWorkspaceDraft({
      agent: 'codex',
      attachments: [],
      linkedIssue: '',
      linkedPR: null,
      linkedWorkItem: null,
      name: 'feature',
      note: '',
      prompt: 'Build it',
      repoId: 'repo1'
    })
    expect(store.getState().newWorkspaceDraft?.name).toBe('feature')
    store.getState().clearNewWorkspaceDraft()
    expect(store.getState().newWorkspaceDraft).toBeNull()

    store.getState().openModal('add-repo', { source: 'test' })
    expect(store.getState().activeModal).toBe('add-repo')
    expect(store.getState().modalData).toEqual({ source: 'test' })
    store.getState().closeModal()
    expect(store.getState().activeModal).toBe('none')

    store.getState().setGroupBy('pr-status')
    expect(store.getState().groupBy).toBe('pr-status')
    expect(store.getState().collapsedGroups).toEqual(new Set())
    store.getState().setSortBy('name')
    store.getState().setShowActiveOnly(true)
    store.getState().setHideDefaultBranchWorkspace(true)
    store.getState().setFilterRepoIds(['repo1'])
    expect(store.getState().sortBy).toBe('name')
    expect(store.getState().showActiveOnly).toBe(true)
    expect(store.getState().hideDefaultBranchWorkspace).toBe(true)
    expect(store.getState().filterRepoIds).toEqual(['repo1'])

    store.getState().toggleCollapsedGroup('repo1')
    expect(store.getState().collapsedGroups).toEqual(new Set(['repo1']))
    store.getState().toggleCollapsedGroup('repo1')
    expect(store.getState().collapsedGroups).toEqual(new Set())

    const firstCardProperty = store.getState().worktreeCardProperties[0]
    store.getState().toggleWorktreeCardProperty(firstCardProperty)
    expect(store.getState().worktreeCardProperties).not.toContain(firstCardProperty)
    store.getState().toggleWorktreeCardProperty(firstCardProperty)
    expect(store.getState().worktreeCardProperties).toContain(firstCardProperty)

    store.getState().setWorkspaceStatuses([{ id: 'custom', label: 'Custom', color: 'blue' }])
    expect(store.getState().workspaceStatuses[0]?.id).toBe('custom')
    store.getState().setWorkspaceBoardOpacity(2)
    expect(store.getState().workspaceBoardOpacity).toBe(1)
    store.getState().setWorkspaceBoardCompact(true)
    expect(store.getState().workspaceBoardCompact).toBe(true)

    const firstStatusBarItem = store.getState().statusBarItems[0]
    store.getState().toggleStatusBarItem(firstStatusBarItem)
    expect(store.getState().statusBarItems).not.toContain(firstStatusBarItem)
    store.getState().toggleStatusBarItem(firstStatusBarItem)
    expect(store.getState().statusBarItems).toContain(firstStatusBarItem)
    store.getState().setStatusBarVisible(false)
    expect(store.getState().statusBarVisible).toBe(false)

    expect(setUI).toHaveBeenCalled()
  })

  it('persists pet state and falls back when removing the active custom pet', () => {
    const { deletePet, setUI } = stubPersistence()
    const store = createUIStore()
    const customPet = {
      id: 'custom-pet',
      label: 'Custom pet',
      fileName: 'custom-pet.webp',
      mimeType: 'image/webp',
      kind: 'image' as const
    }

    store.getState().setPetVisible(false)
    store.getState().setPetId('custom-pet')
    store.getState().setPetSize(9999)
    store.getState().addCustomPet(customPet)

    expect(store.getState().petVisible).toBe(false)
    expect(store.getState().petId).toBe('custom-pet')
    expect(store.getState().customPets).toEqual([customPet])

    store.getState().removeCustomPet('missing')
    expect(store.getState().customPets).toEqual([customPet])

    store.getState().removeCustomPet('custom-pet')

    expect(store.getState().customPets).toEqual([])
    expect(store.getState().petId).not.toBe('custom-pet')
    expect(deletePet).toHaveBeenCalledWith('custom-pet', 'custom-pet.webp', 'image')
    expect(setUI).toHaveBeenCalledWith({ customPets: [], petId: expect.any(String) })
  })

  it('persists hook trust changes and skips duplicate approvals', () => {
    const now = 1_700_000_000_000
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const { setUI } = stubPersistence()

    try {
      const store = createUIStore()

      store.getState().markOrcaHookScriptConfirmed('repo1', 'setup', 'hash-1')
      expect(store.getState().trustedOrcaHooks.repo1?.setup).toEqual({
        contentHash: 'hash-1',
        approvedAt: now
      })
      expect(setUI).toHaveBeenCalledTimes(1)

      const beforeDuplicate = store.getState()
      store.getState().markOrcaHookScriptConfirmed('repo1', 'setup', 'hash-1')
      expect(store.getState()).toBe(beforeDuplicate)

      store.getState().markOrcaHookRepoAlwaysTrusted('repo1')
      expect(store.getState().trustedOrcaHooks.repo1?.all).toEqual({ approvedAt: now })

      store.getState().clearOrcaHookTrustForRepo('missing')
      expect(store.getState().trustedOrcaHooks.repo1).toBeDefined()
      store.getState().clearOrcaHookTrustForRepo('repo1')
      expect(store.getState().trustedOrcaHooks.repo1).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('tracks update, fullscreen, and browser default state', () => {
    const { dismissNudge, setUI } = stubPersistence()
    const store = createUIStore()
    const changelog = { title: 'New build' } as unknown as NonNullable<
      Extract<UpdateStatus, { state: 'available' }>['changelog']
    >

    store.getState().setUpdateStatus({
      state: 'available',
      version: '1.2.3',
      changelog,
      activeNudgeId: 'nudge-1'
    } as UpdateStatus)
    expect(store.getState().updateChangelog).toBe(changelog)
    expect(store.getState().updateCardCollapsed).toBe(false)

    store.getState().setUpdateCardCollapsed(true)
    store.getState().setUpdateStatus({ state: 'downloading', version: '1.2.3' } as UpdateStatus)
    expect(store.getState().updateChangelog).toBe(changelog)
    expect(store.getState().updateCardCollapsed).toBe(false)

    store.getState().setUpdateStatus({ state: 'idle' })
    expect(store.getState().updateChangelog).toBeNull()

    store.getState().setUpdateStatus({
      state: 'available',
      version: '1.2.4',
      activeNudgeId: 'nudge-2'
    } as UpdateStatus)
    store.getState().dismissUpdate()
    expect(store.getState().dismissedUpdateVersion).toBe('1.2.4')
    expect(dismissNudge).toHaveBeenCalled()

    store.getState().clearDismissedUpdateVersion()
    store.getState().markUpdateReassuranceSeen()
    store.getState().setIsFullScreen(true)
    store.getState().setBrowserDefaultUrl('https://example.test')
    store.getState().setBrowserDefaultSearchEngine('kagi')
    store.getState().setBrowserKagiSessionLink('https://kagi.com/search?token=secret&q=%s')

    expect(store.getState().dismissedUpdateVersion).toBeNull()
    expect(store.getState().updateReassuranceSeen).toBe(true)
    expect(store.getState().isFullScreen).toBe(true)
    expect(store.getState().browserDefaultUrl).toBe('https://example.test')
    expect(store.getState().browserDefaultSearchEngine).toBe('kagi')
    expect(store.getState().browserKagiSessionLink).toBe('https://kagi.com/search?token=secret')
    expect(setUI).toHaveBeenCalledWith({ updateReassuranceSeen: true })
  })
})
