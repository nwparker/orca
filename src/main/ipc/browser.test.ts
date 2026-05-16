/* eslint-disable max-lines -- Why: IPC browser coverage shares one large mocked
   Electron/browser-manager harness so handler contracts stay together. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  removeHandlerMock,
  handleMock,
  registerGuestMock,
  unregisterGuestMock,
  getGuestWebContentsIdMock,
  getWorktreeIdForTabMock,
  openDevToolsMock,
  setAnnotationViewportBridgeMock,
  setViewportOverrideMock,
  getDownloadPromptMock,
  acceptDownloadMock,
  cancelDownloadMock,
  getAuthorizedGuestMock,
  setGrabModeMock,
  awaitGrabSelectionMock,
  cancelGrabOpMock,
  captureSelectionScreenshotMock,
  extractHoverPayloadMock,
  showSaveDialogMock,
  browserWindowFromWebContentsMock,
  listProfilesMock,
  createProfileMock,
  deleteProfileMock,
  getProfileMock,
  updateProfileSourceMock,
  resolvePartitionMock,
  clearDefaultSessionCookiesMock,
  pickCookieFileMock,
  importCookiesFromFileMock,
  detectInstalledBrowsersMock,
  selectBrowserProfileMock,
  importCookiesFromBrowserMock
} = vi.hoisted(() => ({
  removeHandlerMock: vi.fn(),
  handleMock: vi.fn(),
  registerGuestMock: vi.fn(),
  unregisterGuestMock: vi.fn(),
  getGuestWebContentsIdMock: vi.fn(),
  getWorktreeIdForTabMock: vi.fn(),
  openDevToolsMock: vi.fn().mockResolvedValue(true),
  setAnnotationViewportBridgeMock: vi.fn().mockResolvedValue(true),
  setViewportOverrideMock: vi.fn(),
  getDownloadPromptMock: vi.fn(),
  acceptDownloadMock: vi.fn(),
  cancelDownloadMock: vi.fn(),
  getAuthorizedGuestMock: vi.fn(),
  setGrabModeMock: vi.fn(),
  awaitGrabSelectionMock: vi.fn(),
  cancelGrabOpMock: vi.fn(),
  captureSelectionScreenshotMock: vi.fn(),
  extractHoverPayloadMock: vi.fn(),
  showSaveDialogMock: vi.fn(),
  browserWindowFromWebContentsMock: vi.fn(),
  listProfilesMock: vi.fn(),
  createProfileMock: vi.fn(),
  deleteProfileMock: vi.fn(),
  getProfileMock: vi.fn(),
  updateProfileSourceMock: vi.fn(),
  resolvePartitionMock: vi.fn(),
  clearDefaultSessionCookiesMock: vi.fn(),
  pickCookieFileMock: vi.fn(),
  importCookiesFromFileMock: vi.fn(),
  detectInstalledBrowsersMock: vi.fn(),
  selectBrowserProfileMock: vi.fn(),
  importCookiesFromBrowserMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    fromWebContents: browserWindowFromWebContentsMock
  },
  dialog: {
    showSaveDialog: showSaveDialogMock
  },
  ipcMain: {
    removeHandler: removeHandlerMock,
    handle: handleMock
  }
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: {
    registerGuest: registerGuestMock,
    unregisterGuest: unregisterGuestMock,
    getGuestWebContentsId: getGuestWebContentsIdMock,
    getWorktreeIdForTab: getWorktreeIdForTabMock,
    openDevTools: openDevToolsMock,
    setAnnotationViewportBridge: setAnnotationViewportBridgeMock,
    setViewportOverride: setViewportOverrideMock,
    getDownloadPrompt: getDownloadPromptMock,
    acceptDownload: acceptDownloadMock,
    cancelDownload: cancelDownloadMock,
    getAuthorizedGuest: getAuthorizedGuestMock,
    setGrabMode: setGrabModeMock,
    awaitGrabSelection: awaitGrabSelectionMock,
    cancelGrabOp: cancelGrabOpMock,
    captureSelectionScreenshot: captureSelectionScreenshotMock,
    extractHoverPayload: extractHoverPayloadMock
  }
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: {
    listProfiles: listProfilesMock,
    createProfile: createProfileMock,
    deleteProfile: deleteProfileMock,
    getProfile: getProfileMock,
    updateProfileSource: updateProfileSourceMock,
    resolvePartition: resolvePartitionMock,
    clearDefaultSessionCookies: clearDefaultSessionCookiesMock
  }
}))

vi.mock('../browser/browser-cookie-import', () => ({
  pickCookieFile: pickCookieFileMock,
  importCookiesFromFile: importCookiesFromFileMock,
  detectInstalledBrowsers: detectInstalledBrowsersMock,
  selectBrowserProfile: selectBrowserProfileMock,
  importCookiesFromBrowser: importCookiesFromBrowserMock
}))

import {
  registerBrowserHandlers,
  setAgentBrowserBridgeRef,
  waitForTabRegistration
} from './browser'

describe('registerBrowserHandlers', () => {
  beforeEach(() => {
    vi.stubEnv('ELECTRON_RENDERER_URL', '')
    removeHandlerMock.mockReset()
    handleMock.mockReset()
    registerGuestMock.mockReset()
    unregisterGuestMock.mockReset()
    getGuestWebContentsIdMock.mockReset()
    getWorktreeIdForTabMock.mockReset()
    openDevToolsMock.mockReset()
    setAnnotationViewportBridgeMock.mockReset()
    setViewportOverrideMock.mockReset()
    getDownloadPromptMock.mockReset()
    acceptDownloadMock.mockReset()
    cancelDownloadMock.mockReset()
    getAuthorizedGuestMock.mockReset()
    setGrabModeMock.mockReset()
    awaitGrabSelectionMock.mockReset()
    cancelGrabOpMock.mockReset()
    captureSelectionScreenshotMock.mockReset()
    extractHoverPayloadMock.mockReset()
    showSaveDialogMock.mockReset()
    browserWindowFromWebContentsMock.mockReset()
    listProfilesMock.mockReset()
    createProfileMock.mockReset()
    deleteProfileMock.mockReset()
    getProfileMock.mockReset()
    updateProfileSourceMock.mockReset()
    resolvePartitionMock.mockReset()
    clearDefaultSessionCookiesMock.mockReset()
    pickCookieFileMock.mockReset()
    importCookiesFromFileMock.mockReset()
    detectInstalledBrowsersMock.mockReset()
    selectBrowserProfileMock.mockReset()
    importCookiesFromBrowserMock.mockReset()
    openDevToolsMock.mockResolvedValue(true)
    setAnnotationViewportBridgeMock.mockResolvedValue(true)
    setAgentBrowserBridgeRef(null)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('rejects non-window callers', async () => {
    registerBrowserHandlers()

    const registerHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:registerGuest'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => boolean

    const result = registerHandler(
      {
        sender: {
          isDestroyed: () => false,
          getType: () => 'webview',
          getURL: () => 'http://localhost:5173/'
        } as Electron.WebContents
      },
      { browserTabId: 'browser-1', webContentsId: 101 }
    )

    expect(result).toBe(false)
    expect(registerGuestMock).not.toHaveBeenCalled()
  })

  it('accepts downloads through a main-owned save dialog', async () => {
    getDownloadPromptMock.mockReturnValue({ filename: 'report.csv' })
    acceptDownloadMock.mockReturnValue({ ok: true })
    showSaveDialogMock.mockResolvedValue({ canceled: false, filePath: '/tmp/report.csv' })

    registerBrowserHandlers()

    const acceptHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:acceptDownload'
    )?.[1] as (
      event: { sender: Electron.WebContents },
      args: { downloadId: string }
    ) => Promise<{ ok: true } | { ok: false; reason: string }>

    const sender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents

    const result = await acceptHandler({ sender }, { downloadId: 'download-1' })

    expect(showSaveDialogMock).toHaveBeenCalledTimes(1)
    expect(acceptDownloadMock).toHaveBeenCalledWith({
      downloadId: 'download-1',
      senderWebContentsId: 91,
      savePath: '/tmp/report.csv'
    })
    expect(result).toEqual({ ok: true })
  })

  it('updates the bridge active tab for the owning worktree', async () => {
    const onTabChangedMock = vi.fn()
    getGuestWebContentsIdMock.mockReturnValue(4242)
    getWorktreeIdForTabMock.mockReturnValue('wt-browser')

    setAgentBrowserBridgeRef({ onTabChanged: onTabChangedMock } as never)
    registerBrowserHandlers()

    const activeTabChangedHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:activeTabChanged'
    )?.[1] as (event: { sender: Electron.WebContents }, args: { browserPageId: string }) => boolean

    const result = activeTabChangedHandler(
      {
        sender: {
          isDestroyed: () => false,
          getType: () => 'window',
          getURL: () => 'file:///renderer/index.html'
        } as Electron.WebContents
      },
      { browserPageId: 'page-1' }
    )

    expect(result).toBe(true)
    expect(onTabChangedMock).toHaveBeenCalledWith(4242, 'wt-browser')
  })

  it('validates annotation viewport bridge requests before syncing to the guest', async () => {
    registerBrowserHandlers()

    const syncHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:setAnnotationViewportBridge'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => Promise<boolean> | boolean

    const sender = {
      id: 91,
      isDestroyed: () => false,
      getType: () => 'window',
      getURL: () => 'file:///renderer/index.html'
    } as Electron.WebContents

    const result = await syncHandler(
      { sender },
      {
        browserPageId: 'page-1',
        emitViewport: false,
        enabled: true,
        markers: [],
        token: 'annotationviewporttoken'
      }
    )

    expect(result).toBe(true)
    expect(setAnnotationViewportBridgeMock).toHaveBeenCalledWith('page-1', {
      emitViewport: false,
      enabled: true,
      markers: [],
      token: 'annotationviewporttoken'
    })
  })

  it('rejects invalid annotation viewport bridge requests', async () => {
    registerBrowserHandlers()

    const syncHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:setAnnotationViewportBridge'
    )?.[1] as (event: { sender: Electron.WebContents }, args: unknown) => boolean

    const result = syncHandler(
      {
        sender: {
          id: 91,
          isDestroyed: () => false,
          getType: () => 'window',
          getURL: () => 'file:///renderer/index.html'
        } as Electron.WebContents
      },
      {
        browserPageId: 'page-1',
        emitViewport: false,
        enabled: true,
        markers: [],
        token: 'short'
      }
    )

    expect(result).toBe(false)
    expect(setAnnotationViewportBridgeMock).not.toHaveBeenCalled()
  })

  it('registers guests, resolves pending tab waits, and reports process swaps', async () => {
    const onProcessSwap = vi.fn()
    getGuestWebContentsIdMock.mockReturnValueOnce(null)
    const pending = waitForTabRegistration('page-wait', 250)

    getGuestWebContentsIdMock.mockReturnValueOnce(100)
    setAgentBrowserBridgeRef({ onProcessSwap } as never)
    registerBrowserHandlers()

    const registerHandler = handleMock.mock.calls.find(
      ([channel]) => channel === 'browser:registerGuest'
    )?.[1] as (
      event: { sender: Electron.WebContents },
      args: {
        browserPageId: string
        workspaceId: string
        worktreeId: string
        webContentsId: number
      }
    ) => boolean
    const sender = trustedSender(91)

    const result = registerHandler(
      { sender },
      {
        browserPageId: 'page-wait',
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        webContentsId: 101
      }
    )

    await expect(pending).resolves.toBeUndefined()
    expect(result).toBe(true)
    expect(registerGuestMock).toHaveBeenCalledWith({
      browserPageId: 'page-wait',
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      webContentsId: 101,
      rendererWebContentsId: 91
    })
    expect(onProcessSwap).toHaveBeenCalledWith('page-wait', 101, 100)
  })

  it('validates viewport overrides at the main-process boundary', () => {
    setViewportOverrideMock.mockReturnValue(true)
    registerBrowserHandlers()

    const handler = getHandler('browser:setViewportOverride') as (
      event: { sender: Electron.WebContents },
      args: { browserPageId: string; override: unknown }
    ) => boolean
    const sender = trustedSender()

    expect(
      handler(
        { sender },
        {
          browserPageId: 'page-1',
          override: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true }
        }
      )
    ).toBe(true)
    expect(setViewportOverrideMock).toHaveBeenCalledWith('page-1', {
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    })

    expect(
      handler(
        { sender },
        {
          browserPageId: 'page-1',
          override: { width: Number.NaN, height: 844, deviceScaleFactor: 3, mobile: true }
        }
      )
    ).toBe(false)
  })

  it('handles browser grab IPC success and readiness failures', async () => {
    const guest = { id: 101 }
    getAuthorizedGuestMock.mockReturnValueOnce(guest).mockReturnValueOnce(null)
    setGrabModeMock.mockResolvedValueOnce(true)
    awaitGrabSelectionMock.mockResolvedValueOnce({ opId: 'op-1', kind: 'selection' })
    captureSelectionScreenshotMock.mockResolvedValueOnce('data:image/png;base64,abc')
    extractHoverPayloadMock.mockResolvedValueOnce({ text: 'Hover' })
    registerBrowserHandlers()
    const sender = trustedSender()

    await expect(
      getHandler('browser:setGrabMode')({ sender }, { browserPageId: 'page-1', enabled: true })
    ).resolves.toEqual({ ok: true })
    await expect(
      getHandler('browser:setGrabMode')({ sender }, { browserPageId: 'page-1', enabled: true })
    ).resolves.toEqual({ ok: false, reason: 'not-ready' })

    getAuthorizedGuestMock.mockReturnValue(guest)
    await expect(
      getHandler('browser:awaitGrabSelection')(
        { sender },
        { browserPageId: 'page-1', opId: 'op-1' }
      )
    ).resolves.toEqual({ opId: 'op-1', kind: 'selection' })
    expect(getHandler('browser:cancelGrab')({ sender }, { browserPageId: 'page-1' })).toBe(true)
    expect(cancelGrabOpMock).toHaveBeenCalledWith('page-1', 'user')
    await expect(
      getHandler('browser:captureSelectionScreenshot')(
        { sender },
        { browserPageId: 'page-1', rect: { x: 1, y: 2, width: 3, height: 4 } }
      )
    ).resolves.toEqual({ ok: true, screenshot: 'data:image/png;base64,abc' })
    await expect(
      getHandler('browser:extractHoverPayload')({ sender }, { browserPageId: 'page-1' })
    ).resolves.toEqual({ ok: true, payload: { text: 'Hover' } })
  })

  it('manages browser session profiles and manual cookie imports', async () => {
    const profile = {
      id: 'profile-1',
      partition: 'persist:profile-1',
      label: 'Profile 1',
      scope: 'isolated',
      source: null
    }
    listProfilesMock.mockReturnValue([profile])
    createProfileMock.mockReturnValue(profile)
    deleteProfileMock.mockResolvedValue(true)
    getProfileMock.mockReturnValue(profile)
    resolvePartitionMock.mockReturnValue(profile.partition)
    clearDefaultSessionCookiesMock.mockResolvedValue(true)
    pickCookieFileMock.mockResolvedValue('/tmp/cookies.json')
    importCookiesFromFileMock.mockResolvedValue({
      ok: true,
      profileId: '',
      summary: { totalCookies: 1, importedCookies: 1, skippedCookies: 0, domains: ['example.com'] }
    })
    registerBrowserHandlers()
    const sender = trustedSender()

    expect(getHandler('browser:session:listProfiles')({ sender })).toEqual([profile])
    expect(
      getHandler('browser:session:createProfile')(
        { sender },
        { scope: 'isolated', label: 'Profile 1' }
      )
    ).toEqual(profile)
    await expect(
      getHandler('browser:session:deleteProfile')({ sender }, { profileId: 'profile-1' })
    ).resolves.toBe(true)
    expect(
      getHandler('browser:session:resolvePartition')({ sender }, { profileId: 'profile-1' })
    ).toBe('persist:profile-1')
    await expect(getHandler('browser:session:clearDefaultCookies')({ sender })).resolves.toBe(true)

    await expect(
      getHandler('browser:session:importCookies')({ sender }, { profileId: 'profile-1' })
    ).resolves.toMatchObject({ ok: true, profileId: 'profile-1' })
    expect(importCookiesFromFileMock).toHaveBeenCalledWith('/tmp/cookies.json', 'persist:profile-1')
    expect(updateProfileSourceMock).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ browserFamily: 'manual' })
    )
  })

  it('detects browsers and imports from selected installed browser profiles', async () => {
    const profile = {
      id: 'profile-1',
      partition: 'persist:profile-1',
      label: 'Profile 1',
      scope: 'isolated',
      source: null
    }
    const browser = {
      family: 'chrome',
      label: 'Google Chrome',
      cookiesPath: '/source/default/Cookies',
      keychainService: 'Chrome Safe Storage',
      keychainAccount: 'Chrome',
      profiles: [
        { name: 'Default', directory: 'Default' },
        { name: 'Work', directory: 'Profile 1' }
      ],
      selectedProfile: 'Default'
    }
    const selectedBrowser = {
      ...browser,
      cookiesPath: '/source/profile-1/Cookies',
      selectedProfile: 'Profile 1'
    }
    getProfileMock.mockReturnValue(profile)
    detectInstalledBrowsersMock.mockReturnValue([browser])
    selectBrowserProfileMock.mockReturnValue(selectedBrowser)
    importCookiesFromBrowserMock.mockResolvedValue({
      ok: true,
      profileId: '',
      summary: { totalCookies: 2, importedCookies: 2, skippedCookies: 0, domains: ['example.com'] }
    })
    registerBrowserHandlers()
    const sender = trustedSender()

    expect(getHandler('browser:session:detectBrowsers')({ sender })).toEqual([
      {
        family: 'chrome',
        label: 'Google Chrome',
        profiles: browser.profiles,
        selectedProfile: 'Default'
      }
    ])
    await expect(
      getHandler('browser:session:importFromBrowser')(
        { sender },
        { profileId: 'profile-1', browserFamily: 'chrome', browserProfile: 'Profile 1' }
      )
    ).resolves.toMatchObject({ ok: true, profileId: 'profile-1' })
    expect(selectBrowserProfileMock).toHaveBeenCalledWith(browser, 'Profile 1')
    expect(importCookiesFromBrowserMock).toHaveBeenCalledWith(selectedBrowser, 'persist:profile-1')
    expect(updateProfileSourceMock).toHaveBeenCalledWith(
      'profile-1',
      expect.objectContaining({ browserFamily: 'chrome', profileName: 'Work' })
    )
  })
})

function trustedSender(id = 91): Electron.WebContents {
  return {
    id,
    isDestroyed: () => false,
    getType: () => 'window',
    getURL: () => 'file:///renderer/index.html'
  } as Electron.WebContents
}

function getHandler(channel: string) {
  const handler = handleMock.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel
  )?.[1]
  if (!handler) {
    throw new Error(`Handler not registered: ${channel}`)
  }
  return handler
}
