/* eslint-disable max-lines -- Why: browser slice behavior shares one mocked store harness; splitting only the tests would duplicate more setup than it saves. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import { createBrowserSlice } from './browser'
import type { AppState } from '../types'
import type { BrowserPage, BrowserSessionProfile, BrowserWorkspace } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { GRAB_BUDGET, type BrowserPageAnnotation } from '../../../../shared/browser-grab-types'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

const mockApi = {
  browser: {
    sessionListProfiles: vi.fn().mockResolvedValue([]),
    sessionCreateProfile: vi.fn().mockResolvedValue(null),
    sessionDeleteProfile: vi.fn().mockResolvedValue(false),
    sessionImportCookies: vi.fn().mockResolvedValue({ ok: false, reason: 'canceled' }),
    sessionDetectBrowsers: vi.fn().mockResolvedValue([]),
    sessionImportFromBrowser: vi.fn().mockResolvedValue({ ok: false, reason: 'canceled' }),
    sessionClearDefaultCookies: vi.fn().mockResolvedValue(false),
    notifyActiveTabChanged: vi.fn().mockResolvedValue(undefined)
  },
  runtimeEnvironments: {
    call: runtimeEnvironmentTransportCall
  }
}

// @ts-expect-error test window mock
globalThis.window = { api: mockApi }

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        settings: { activeRuntimeEnvironmentId: null } as AppState['settings'],
        unifiedTabsByWorktree: {},
        tabBarOrderByWorktree: {},
        tabsByWorktree: {},
        openFiles: [],
        activeTabType: 'terminal',
        activeTabTypeByWorktree: {},
        worktreesByRepo: {},
        createUnifiedTab: vi.fn(),
        closeUnifiedTab: vi.fn(),
        activateTab: vi.fn(),
        setTabLabel: vi.fn(),
        ...createBrowserSlice(...a)
      }) as unknown as AppState
  )
}

function settingsWithRuntime(id: string): AppState['settings'] {
  return { activeRuntimeEnvironmentId: id } as AppState['settings']
}

function makeAnnotation(pageId: string, id = 'annotation-1'): BrowserPageAnnotation {
  return {
    id,
    browserPageId: pageId,
    comment: 'Fix this button',
    intent: 'fix',
    priority: 'important',
    createdAt: '2026-05-15T00:00:00.000Z',
    payload: {
      page: {
        sanitizedUrl: 'https://example.com',
        title: 'Example',
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        capturedAt: '2026-05-15T00:00:00.000Z'
      },
      target: {
        tagName: 'button',
        selector: 'button',
        textSnippet: 'Submit',
        htmlSnippet: '<button>Submit</button>',
        attributes: {},
        accessibility: {
          role: 'button',
          accessibleName: 'Submit',
          ariaLabel: null,
          ariaLabelledBy: null
        },
        rectViewport: { x: 0, y: 0, width: 100, height: 40 },
        rectPage: { x: 0, y: 0, width: 100, height: 40 },
        computedStyles: {
          display: 'inline-flex',
          position: 'static',
          width: '100px',
          height: '40px',
          margin: '0px',
          padding: '0px',
          color: 'rgb(0, 0, 0)',
          backgroundColor: 'rgba(0, 0, 0, 0)',
          border: '0px none',
          borderRadius: '0px',
          fontFamily: 'Geist',
          fontSize: '14px',
          fontWeight: '400',
          lineHeight: '20px',
          textAlign: 'center',
          zIndex: 'auto'
        }
      },
      nearbyText: [],
      ancestorPath: [],
      screenshot: null
    }
  }
}

describe('createBrowserSlice annotations', () => {
  it('clears page annotations when the browser page URL changes', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }

    store.getState().addBrowserPageAnnotation(makeAnnotation(pageId))
    expect(store.getState().browserAnnotationsByPageId[pageId]).toHaveLength(1)

    store.getState().setBrowserPageUrl(pageId, 'https://example.com/next')

    expect(store.getState().browserAnnotationsByPageId[pageId]).toBeUndefined()
  })

  it('caps stored browser annotations per page', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }

    for (let index = 0; index < GRAB_BUDGET.annotationsMaxPerPage + 3; index++) {
      store.getState().addBrowserPageAnnotation(makeAnnotation(pageId, `annotation-${index}`))
    }

    const annotations = store.getState().browserAnnotationsByPageId[pageId] ?? []
    expect(annotations).toHaveLength(GRAB_BUDGET.annotationsMaxPerPage)
    expect(annotations[0]?.id).toBe('annotation-3')
  })

  it('sanitizes persistent annotation payloads at the store boundary', () => {
    const store = createTestStore()
    const tab = store.getState().createBrowserTab('wt-1', 'https://example.com')
    const pageId = tab.activePageId
    if (!pageId) {
      throw new Error('Expected a new browser page')
    }
    const annotation = makeAnnotation(pageId)
    const oversizedComment = 'a'.repeat(GRAB_BUDGET.annotationCommentMaxLength + 10)

    store.getState().addBrowserPageAnnotation({
      ...annotation,
      comment: oversizedComment,
      payload: {
        ...annotation.payload,
        screenshot: {
          mimeType: 'image/png',
          dataUrl: 'data:image/png;base64,abc',
          width: 1,
          height: 1
        }
      } as unknown as BrowserPageAnnotation['payload']
    })

    const stored = store.getState().browserAnnotationsByPageId[pageId]?.[0]
    expect(stored?.comment).toHaveLength(GRAB_BUDGET.annotationCommentMaxLength)
    expect(stored?.payload.screenshot).toBeNull()
  })
})

function browserProfile(overrides: Partial<BrowserSessionProfile> = {}): BrowserSessionProfile {
  return {
    id: 'profile-1',
    scope: 'isolated',
    partition: 'persist:profile-1',
    label: 'Profile 1',
    source: null,
    ...overrides
  }
}

function browserPage(overrides: Partial<BrowserPage> = {}): BrowserPage {
  return {
    id: 'page-1',
    workspaceId: 'workspace-1',
    worktreeId: 'wt-1',
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1,
    ...overrides
  }
}

function browserWorkspace(overrides: Partial<BrowserWorkspace> = {}): BrowserWorkspace {
  return {
    id: 'workspace-1',
    worktreeId: 'wt-1',
    sessionProfileId: null,
    activePageId: 'page-1',
    pageIds: ['page-1'],
    url: 'https://example.com',
    title: 'Example',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1,
    ...overrides
  }
}

describe('createBrowserSlice runtime guard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearRuntimeCompatibilityCacheForTests()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    runtimeEnvironmentCall.mockResolvedValue({ id: 'rpc-1', ok: true, result: {} })
  })

  it('fetches browser profiles from the active runtime environment', async () => {
    const store = createTestStore()
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: {
        profiles: [
          {
            id: 'default',
            scope: 'default',
            partition: 'persist:orca-default',
            label: 'Default',
            source: null
          }
        ]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: settingsWithRuntime('env-1'),
      browserSessionProfiles: []
    })

    await store.getState().fetchBrowserSessionProfiles()

    expect(mockApi.browser.sessionListProfiles).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'browser.profileList',
      params: undefined,
      timeoutMs: 15_000
    })
    expect(store.getState().browserSessionProfiles).toEqual([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-default',
        label: 'Default',
        source: null
      }
    ])
  })

  it('does not import local browser cookies while a runtime environment is active', async () => {
    const store = createTestStore()
    store.setState({ settings: settingsWithRuntime('env-1') })

    const result = await store.getState().importCookiesToProfile('default')

    expect(mockApi.browser.sessionImportCookies).not.toHaveBeenCalled()
    expect(result.ok).toBe(false)
    expect(store.getState().browserSessionImportState).toMatchObject({
      profileId: 'default',
      status: 'error'
    })
  })

  it('uses local browser IPC when no runtime environment is active', async () => {
    const store = createTestStore()
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-default',
        label: 'Default',
        source: null
      }
    ])

    await store.getState().fetchBrowserSessionProfiles()

    expect(mockApi.browser.sessionListProfiles).toHaveBeenCalledTimes(1)
    expect(store.getState().browserSessionProfiles).toEqual([
      {
        id: 'default',
        scope: 'default',
        partition: 'persist:orca-default',
        label: 'Default',
        source: null
      }
    ])
  })

  it('does not notify the local browser manager when selecting tabs under runtime', () => {
    const store = createTestStore()
    store.setState({
      settings: settingsWithRuntime('env-1'),
      unifiedTabsByWorktree: {},
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: null,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'about:blank',
            title: 'New Tab',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      }
    })

    store.getState().setActiveBrowserTab('workspace-1')

    expect(mockApi.browser.notifyActiveTabChanged).not.toHaveBeenCalled()
  })

  it('closes the mapped remote tab when closing a browser page in the active runtime', async () => {
    const store = createTestStore()
    store.setState({
      settings: settingsWithRuntime('env-1'),
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: null,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            id: 'page-1',
            workspaceId: 'workspace-1',
            worktreeId: 'wt-1',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      remoteBrowserPageHandlesByPageId: {
        'page-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
      }
    })

    store.getState().closeBrowserPage('page-1')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
    expect(store.getState().remoteBrowserPageHandlesByPageId['page-1']).toBeUndefined()
  })

  it('closes mapped remote tabs when closing a browser workspace in the active runtime', async () => {
    const store = createTestStore()
    store.setState({
      settings: settingsWithRuntime('env-1'),
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: null,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      activeBrowserTabId: 'workspace-1',
      activeBrowserTabIdByWorktree: { 'wt-1': 'workspace-1' },
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            id: 'page-1',
            workspaceId: 'workspace-1',
            worktreeId: 'wt-1',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      remoteBrowserPageHandlesByPageId: {
        'page-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
      }
    })

    store.getState().closeBrowserTab('workspace-1')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
    expect(store.getState().remoteBrowserPageHandlesByPageId['page-1']).toBeUndefined()
  })

  it('closes mapped remote pages in their owning environment after switching local', async () => {
    const store = createTestStore()
    store.setState({
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: null,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            id: 'page-1',
            workspaceId: 'workspace-1',
            worktreeId: 'wt-1',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      remoteBrowserPageHandlesByPageId: {
        'page-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
      }
    })

    store.getState().closeBrowserPage('page-1')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
  })

  it('closes mapped remote tabs in their owning environment after switching environments', async () => {
    const store = createTestStore()
    store.setState({
      settings: settingsWithRuntime('env-2'),
      browserTabsByWorktree: {
        'wt-1': [
          {
            id: 'workspace-1',
            worktreeId: 'wt-1',
            sessionProfileId: null,
            activePageId: 'page-1',
            pageIds: ['page-1'],
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      browserPagesByWorkspace: {
        'workspace-1': [
          {
            id: 'page-1',
            workspaceId: 'workspace-1',
            worktreeId: 'wt-1',
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 1
          }
        ]
      },
      remoteBrowserPageHandlesByPageId: {
        'page-1': { environmentId: 'env-1', remotePageId: 'remote-page-1' }
      }
    })

    store.getState().closeBrowserTab('workspace-1')

    await vi.waitFor(() => {
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
        selector: 'env-1',
        method: 'browser.tabClose',
        params: { worktree: 'id:wt-1', page: 'remote-page-1' },
        timeoutMs: 15_000
      })
    })
  })

  it('creates browser tabs and pages with scoped focus and mirrored page state', () => {
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-1',
      defaultBrowserSessionProfileId: 'profile-default',
      tabsByWorktree: {
        'wt-1': [{ id: 'terminal-1' } as AppState['tabsByWorktree'][string][number]]
      },
      tabBarOrderByWorktree: { 'wt-1': ['terminal-1'] }
    })

    const tab = store.getState().createBrowserTab('wt-1', '   ', {
      focusAddressBar: true,
      targetGroupId: 'group-1'
    })

    expect(tab.sessionProfileId).toBe('profile-default')
    expect(tab.title).toBe('New Tab')
    expect(store.getState().activeBrowserTabId).toBe(tab.id)
    expect(store.getState().activeTabType).toBe('browser')
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual(['terminal-1', tab.id])
    expect(store.getState().createUnifiedTab).toHaveBeenCalledWith('wt-1', 'browser', {
      entityId: tab.id,
      label: 'New Tab',
      targetGroupId: 'group-1'
    })

    const firstPageId = tab.activePageId ?? ''
    expect(store.getState().consumeAddressBarFocusRequest(firstPageId)).toBe(true)
    expect(store.getState().consumeAddressBarFocusRequest(firstPageId)).toBe(false)

    store.setState({
      unifiedTabsByWorktree: {
        'wt-1': [{ id: 'unified-browser-1', contentType: 'browser', entityId: tab.id }]
      } as unknown as AppState['unifiedTabsByWorktree']
    })

    const backgroundPage = store.getState().createBrowserPage(tab.id, 'https://background.test', {
      title: 'Background',
      activate: false
    })
    expect(backgroundPage).not.toBeNull()
    expect(store.getState().browserTabsByWorktree['wt-1'][0].activePageId).toBe(firstPageId)

    const activePage = store.getState().createBrowserPage(tab.id, 'https://active.test', {
      title: 'Active',
      activate: true
    })
    expect(activePage).not.toBeNull()
    expect(store.getState().browserTabsByWorktree['wt-1'][0]).toMatchObject({
      activePageId: activePage?.id,
      url: 'https://active.test',
      title: 'Active'
    })
    expect(store.getState().setTabLabel).toHaveBeenCalledWith('unified-browser-1', 'Active')

    store.getState().setActiveBrowserTab(tab.id)
    expect(mockApi.browser.notifyActiveTabChanged).toHaveBeenCalledWith({
      browserPageId: activePage?.id
    })
    expect(store.getState().activateTab).toHaveBeenCalledWith('unified-browser-1')

    store
      .getState()
      .setBrowserPageUrl(activePage?.id ?? '', ' https://kagi.com/search?q=orca&token=secret ')
    store.getState().updateBrowserPageState(activePage?.id ?? '', {
      title: 'Updated',
      loading: false,
      faviconUrl: 'https://example.com/favicon.ico',
      canGoBack: true,
      canGoForward: true,
      loadError: { code: -105, description: 'Name not resolved', validatedUrl: 'https://bad.test' }
    })

    const updatedWorkspace = store.getState().browserTabsByWorktree['wt-1'][0]
    expect(updatedWorkspace).toMatchObject({
      url: 'https://kagi.com/search?q=orca',
      title: 'Updated',
      loading: false,
      faviconUrl: 'https://example.com/favicon.ico',
      canGoBack: true,
      canGoForward: true,
      loadError: { code: -105 }
    })
    expect(store.getState().setTabLabel).toHaveBeenCalledWith('unified-browser-1', 'Updated')

    store.getState().setBrowserPageViewportPreset(activePage?.id ?? '', 'mobile-m')
    expect(store.getState().browserPagesByWorkspace[tab.id].at(-1)).toMatchObject({
      viewportPresetId: 'mobile-m'
    })
  })

  it('removes remote handles only when the optional remote page id matches', () => {
    const store = createTestStore()
    const handle = { environmentId: 'env-1', remotePageId: 'remote-page-1' }

    store.getState().setRemoteBrowserPageHandle('page-1', handle)

    expect(store.getState().removeRemoteBrowserPageHandle('page-1', 'remote-page-2')).toBeNull()
    expect(store.getState().remoteBrowserPageHandlesByPageId['page-1']).toEqual(handle)
    expect(store.getState().removeRemoteBrowserPageHandle('page-1', 'remote-page-1')).toEqual(
      handle
    )
    expect(store.getState().remoteBrowserPageHandlesByPageId['page-1']).toBeUndefined()
  })

  it('closes and reopens browser pages and workspaces without losing local ordering', () => {
    const store = createTestStore()
    const firstPage = browserPage({ id: 'page-1', workspaceId: 'workspace-1', title: 'One' })
    const secondPage = browserPage({
      id: 'page-2',
      workspaceId: 'workspace-1',
      url: 'https://two.test',
      title: 'Two'
    })
    store.setState({
      activeWorktreeId: 'wt-1',
      activeBrowserTabId: 'workspace-1',
      activeBrowserTabIdByWorktree: { 'wt-1': 'workspace-1' },
      activeTabType: 'browser',
      activeTabTypeByWorktree: { 'wt-1': 'browser' },
      browserTabsByWorktree: {
        'wt-1': [
          browserWorkspace({
            id: 'workspace-1',
            activePageId: 'page-2',
            pageIds: ['page-1', 'page-2'],
            url: secondPage.url,
            title: secondPage.title
          }),
          browserWorkspace({
            id: 'workspace-2',
            activePageId: 'page-3',
            pageIds: ['page-3'],
            url: 'https://three.test',
            title: 'Three'
          })
        ]
      },
      browserPagesByWorkspace: {
        'workspace-1': [firstPage, secondPage],
        'workspace-2': [
          browserPage({
            id: 'page-3',
            workspaceId: 'workspace-2',
            url: 'https://three.test',
            title: 'Three'
          })
        ]
      },
      unifiedTabsByWorktree: {
        'wt-1': [
          { id: 'unified-browser-1', contentType: 'browser', entityId: 'workspace-1' },
          { id: 'unified-browser-2', contentType: 'browser', entityId: 'workspace-2' }
        ]
      } as unknown as AppState['unifiedTabsByWorktree'],
      tabBarOrderByWorktree: { 'wt-1': ['workspace-1', 'workspace-2'] },
      pendingAddressBarFocusByPageId: { 'page-2': true },
      pendingAddressBarFocusByTabId: { 'workspace-1': true, 'page-2': true }
    })

    store.getState().closeBrowserPage('page-2')

    expect(store.getState().browserTabsByWorktree['wt-1'][0]).toMatchObject({
      activePageId: 'page-1',
      title: 'One'
    })
    expect(store.getState().pendingAddressBarFocusByPageId['page-2']).toBeUndefined()
    expect(store.getState().recentlyClosedBrowserPagesByWorkspace['workspace-1'][0]).toMatchObject({
      id: 'page-2',
      title: 'Two'
    })

    const reopenedPage = store.getState().reopenClosedBrowserPage('workspace-1')
    expect(reopenedPage).not.toBeNull()
    expect(store.getState().browserTabsByWorktree['wt-1'][0]).toMatchObject({
      title: 'Two'
    })
    expect(store.getState().recentlyClosedBrowserPagesByWorkspace['workspace-1']).toEqual([])

    store.getState().closeBrowserTab('workspace-1')
    expect(store.getState().activeBrowserTabId).toBe('workspace-2')
    expect(store.getState().tabBarOrderByWorktree['wt-1']).toEqual(['workspace-2'])
    expect(store.getState().closeUnifiedTab).toHaveBeenCalledWith('unified-browser-1')

    const restoredWorkspace = store.getState().reopenClosedBrowserTab('wt-1')
    expect(restoredWorkspace).not.toBeNull()
    expect(store.getState().browserPagesByWorkspace[restoredWorkspace?.id ?? '']).toHaveLength(2)
    expect(store.getState().browserTabsByWorktree['wt-1'].at(-1)).toMatchObject({
      title: 'Two',
      sessionProfileId: null
    })

    store.getState().switchBrowserTabProfile(restoredWorkspace?.id ?? '', 'profile-2')
    expect(store.getState().browserTabsByWorktree['wt-1'].at(-1)).toMatchObject({
      sessionProfileId: 'profile-2'
    })
  })

  it('focuses browser pages inside a worktree without stealing global focus from another worktree', () => {
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-visible',
      activeBrowserTabId: 'visible-workspace',
      activeTabType: 'terminal',
      browserTabsByWorktree: {
        'wt-hidden': [
          browserWorkspace({
            id: 'hidden-workspace',
            worktreeId: 'wt-hidden',
            activePageId: 'hidden-page-1',
            pageIds: ['hidden-page-1', 'hidden-page-2']
          })
        ],
        'wt-visible': [
          browserWorkspace({
            id: 'visible-workspace',
            worktreeId: 'wt-visible',
            activePageId: 'visible-page-1',
            pageIds: ['visible-page-1']
          })
        ]
      },
      browserPagesByWorkspace: {
        'hidden-workspace': [
          browserPage({
            id: 'hidden-page-1',
            workspaceId: 'hidden-workspace',
            worktreeId: 'wt-hidden',
            title: 'Hidden 1'
          }),
          browserPage({
            id: 'hidden-page-2',
            workspaceId: 'hidden-workspace',
            worktreeId: 'wt-hidden',
            url: 'https://hidden-two.test',
            title: 'Hidden 2'
          })
        ],
        'visible-workspace': [
          browserPage({
            id: 'visible-page-1',
            workspaceId: 'visible-workspace',
            worktreeId: 'wt-visible'
          })
        ]
      },
      unifiedTabsByWorktree: {
        'wt-hidden': [
          { id: 'unified-hidden-browser', contentType: 'browser', entityId: 'hidden-workspace' }
        ]
      } as unknown as AppState['unifiedTabsByWorktree']
    })

    store.getState().focusBrowserTabInWorktree('wt-hidden', 'hidden-page-2', {
      surfacePane: false
    })

    expect(store.getState().browserTabsByWorktree['wt-hidden'][0]).toMatchObject({
      activePageId: 'hidden-page-2',
      title: 'Hidden 2'
    })
    expect(store.getState().activeBrowserTabIdByWorktree['wt-hidden']).toBe('hidden-workspace')
    expect(store.getState().activeBrowserTabId).toBe('visible-workspace')
    expect(store.getState().activeTabType).toBe('terminal')
    expect(store.getState().activeTabTypeByWorktree['wt-hidden']).toBeUndefined()
    expect(store.getState().activateTab).toHaveBeenCalledWith('unified-hidden-browser')
    expect(mockApi.browser.notifyActiveTabChanged).toHaveBeenCalledWith({
      browserPageId: 'hidden-page-2'
    })
  })

  it('hydrates browser session state from valid persisted worktrees', () => {
    const store = createTestStore()
    store.setState({
      activeWorktreeId: 'wt-1',
      activeTabType: 'terminal',
      activeTabTypeByWorktree: { 'wt-orphan': 'browser' },
      worktreesByRepo: {
        repo: [{ id: 'wt-1' } as AppState['worktreesByRepo'][string][number]]
      },
      openFiles: [{ id: 'file-1', worktreeId: 'wt-1' } as AppState['openFiles'][number]]
    })

    store.getState().hydrateBrowserSession({
      browserTabsByWorktree: {
        'wt-1': [
          browserWorkspace({
            id: 'workspace-1',
            activePageId: 'page-2',
            pageIds: ['page-1', 'page-2'],
            url: 'https://kagi.com/search?q=orca&token=secret',
            title: 'Persisted'
          })
        ],
        'wt-orphan': [
          browserWorkspace({
            id: 'orphan-workspace',
            worktreeId: 'wt-orphan',
            activePageId: 'orphan-page'
          })
        ]
      },
      browserPagesByWorkspace: {
        'workspace-1': [
          browserPage({
            id: 'page-1',
            title: 'One',
            loading: true,
            loadError: { code: -1, description: 'stale', validatedUrl: 'https://one.test' }
          }),
          browserPage({
            id: 'page-2',
            url: 'https://kagi.com/search?q=orca&token=secret',
            title: 'Two',
            loading: true
          })
        ]
      },
      activeBrowserTabIdByWorktree: { 'wt-1': 'workspace-1' },
      activeTabTypeByWorktree: { 'wt-1': 'browser' },
      browserUrlHistory: [
        {
          url: 'https://example.com/path#hash',
          normalizedUrl: 'https://example.com/path',
          title: 'Example',
          lastVisitedAt: 10,
          visitCount: 1
        },
        {
          url: 'about:blank',
          normalizedUrl: 'about:blank',
          title: 'Blank',
          lastVisitedAt: 9,
          visitCount: 1
        }
      ]
    } as unknown as Parameters<AppState['hydrateBrowserSession']>[0])

    expect(store.getState().browserTabsByWorktree).toEqual({
      'wt-1': [
        expect.objectContaining({
          id: 'workspace-1',
          activePageId: 'page-2',
          url: 'https://kagi.com/search?q=orca',
          title: 'Two',
          loading: false
        })
      ]
    })
    expect(store.getState().browserPagesByWorkspace['workspace-1']).toEqual([
      expect.objectContaining({
        id: 'page-1',
        loading: false,
        loadError: expect.objectContaining({ code: -1 })
      }),
      expect.objectContaining({
        id: 'page-2',
        worktreeId: 'wt-1',
        url: 'https://kagi.com/search?q=orca',
        loading: false
      })
    ])
    expect(store.getState().activeBrowserTabId).toBe('workspace-1')
    expect(store.getState().activeTabType).toBe('browser')
    expect(store.getState().remoteBrowserPageHandlesByPageId).toEqual({})
    expect(store.getState().browserUrlHistory[0]).toMatchObject({
      url: 'https://example.com/path#hash',
      normalizedUrl: 'https://example.com/path#hash'
    })
    expect(store.getState().createUnifiedTab).toHaveBeenCalledWith('wt-1', 'browser', {
      entityId: 'workspace-1',
      label: 'Two'
    })
  })

  it('manages local browser profiles, browser imports, and history entries', async () => {
    const store = createTestStore()
    const profile = browserProfile({ id: 'local-profile', label: 'Local Profile' })
    const summary = {
      totalCookies: 3,
      importedCookies: 2,
      skippedCookies: 1,
      domains: ['example.com']
    }

    mockApi.browser.sessionCreateProfile.mockResolvedValueOnce(profile)
    expect(await store.getState().createBrowserSessionProfile('isolated', 'Local Profile')).toEqual(
      profile
    )
    expect(store.getState().browserSessionProfiles).toEqual([profile])

    mockApi.browser.sessionImportCookies.mockResolvedValueOnce({
      ok: true,
      profileId: 'local-profile',
      summary
    })
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([profile])
    expect(await store.getState().importCookiesToProfile('local-profile')).toEqual({
      ok: true,
      profileId: 'local-profile',
      summary
    })
    expect(store.getState().browserSessionImportState).toMatchObject({
      profileId: 'local-profile',
      status: 'success',
      summary
    })

    mockApi.browser.sessionDetectBrowsers.mockResolvedValueOnce([
      {
        family: 'chrome',
        label: 'Chrome',
        profiles: [{ name: 'Default', directory: '/profiles/default' }],
        selectedProfile: 'Default'
      }
    ])
    await store.getState().fetchDetectedBrowsers()
    await store.getState().fetchDetectedBrowsers()
    expect(mockApi.browser.sessionDetectBrowsers).toHaveBeenCalledTimes(1)
    expect(store.getState().detectedBrowsersLoaded).toBe(true)
    expect(store.getState().detectedBrowsers[0]).toMatchObject({ family: 'chrome' })

    mockApi.browser.sessionImportFromBrowser.mockResolvedValueOnce({
      ok: true,
      profileId: 'local-profile',
      summary
    })
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([profile])
    await expect(
      store.getState().importCookiesFromBrowser('local-profile', 'chrome', 'Default')
    ).resolves.toEqual({ ok: true, profileId: 'local-profile', summary })

    mockApi.browser.sessionClearDefaultCookies.mockResolvedValueOnce(true)
    mockApi.browser.sessionListProfiles.mockResolvedValueOnce([profile])
    await expect(store.getState().clearDefaultSessionCookies()).resolves.toBe(true)

    store.getState().setDefaultBrowserSessionProfileId('local-profile')
    mockApi.browser.sessionDeleteProfile.mockResolvedValueOnce(true)
    await expect(store.getState().deleteBrowserSessionProfile('local-profile')).resolves.toBe(true)
    expect(store.getState().browserSessionProfiles).toEqual([])
    expect(store.getState().defaultBrowserSessionProfileId).toBeNull()

    store.getState().addBrowserHistoryEntry('https://kagi.com/search?q=orca&token=secret', 'Orca')
    store.getState().addBrowserHistoryEntry('https://kagi.com/search?q=orca', 'Orca Again')
    store.getState().addBrowserHistoryEntry('about:blank', 'Blank')
    expect(store.getState().browserUrlHistory).toHaveLength(1)
    expect(store.getState().browserUrlHistory[0]).toMatchObject({
      url: 'https://kagi.com/search?q=orca',
      title: 'Orca Again',
      visitCount: 2
    })
    store.getState().clearBrowserHistory()
    expect(store.getState().browserUrlHistory).toEqual([])
    store.getState().clearBrowserSessionImportState()
    expect(store.getState().browserSessionImportState).toBeNull()
  })

  it('uses the active runtime environment for browser profile management', async () => {
    const store = createTestStore()
    const profile = browserProfile({ id: 'runtime-profile', label: 'Runtime Profile' })
    const summary = {
      totalCookies: 4,
      importedCookies: 4,
      skippedCookies: 0,
      domains: ['runtime.test']
    }
    store.setState({
      settings: settingsWithRuntime('env-1'),
      browserSessionProfiles: [profile],
      defaultBrowserSessionProfileId: 'runtime-profile'
    })
    runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
      switch (request.method) {
        case 'browser.profileCreate':
          return Promise.resolve({
            id: 'rpc',
            ok: true,
            result: { profile },
            _meta: { runtimeId: 'env-1' }
          })
        case 'browser.profileDelete':
          return Promise.resolve({
            id: 'rpc',
            ok: true,
            result: { deleted: true },
            _meta: { runtimeId: 'env-1' }
          })
        case 'browser.profileDetectBrowsers':
          return Promise.resolve({
            id: 'rpc',
            ok: true,
            result: {
              browsers: [
                {
                  family: 'chromium',
                  label: 'Chromium',
                  profiles: [{ name: 'Default', directory: '/remote/default' }],
                  selectedProfile: 'Default'
                }
              ]
            },
            _meta: { runtimeId: 'env-1' }
          })
        case 'browser.profileImportFromBrowser':
          return Promise.resolve({
            id: 'rpc',
            ok: true,
            result: { ok: true, profileId: 'runtime-profile', summary },
            _meta: { runtimeId: 'env-1' }
          })
        case 'browser.profileClearDefaultCookies':
          return Promise.resolve({
            id: 'rpc',
            ok: true,
            result: { cleared: true },
            _meta: { runtimeId: 'env-1' }
          })
        case 'browser.profileList':
          return Promise.resolve({
            id: 'rpc',
            ok: true,
            result: { profiles: [profile] },
            _meta: { runtimeId: 'env-1' }
          })
        default:
          return Promise.resolve({ id: 'rpc', ok: true, result: {} })
      }
    })

    await expect(
      store.getState().createBrowserSessionProfile('isolated', 'Runtime Profile')
    ).resolves.toEqual(profile)
    await expect(store.getState().fetchDetectedBrowsers()).resolves.toBeUndefined()
    expect(store.getState().detectedBrowsers[0]).toMatchObject({ family: 'chromium' })

    await expect(
      store.getState().importCookiesFromBrowser('runtime-profile', 'chromium', 'Default')
    ).resolves.toEqual({ ok: true, profileId: 'runtime-profile', summary })
    expect(store.getState().browserSessionImportState).toMatchObject({
      profileId: 'runtime-profile',
      status: 'success',
      summary
    })
    await expect(store.getState().clearDefaultSessionCookies()).resolves.toBe(true)
    await expect(store.getState().deleteBrowserSessionProfile('runtime-profile')).resolves.toBe(
      true
    )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'browser.profileCreate',
        params: { scope: 'isolated', label: 'Runtime Profile' },
        timeoutMs: 15_000
      })
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        method: 'browser.profileImportFromBrowser',
        params: {
          profileId: 'runtime-profile',
          browserFamily: 'chromium',
          browserProfile: 'Default'
        },
        timeoutMs: 30_000
      })
    )
    expect(store.getState().defaultBrowserSessionProfileId).toBeNull()
  })
})
