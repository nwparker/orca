/* eslint-disable max-lines -- Why: runtime browser command coverage shares a
   bridge mock across the command matrix and target-routing cases. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentBrowserBridge } from '../browser/agent-browser-bridge'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import {
  importCookiesFromBrowser,
  selectBrowserProfile,
  type DetectedBrowser
} from '../browser/browser-cookie-import'
import { waitForTabRegistration } from '../ipc/browser'
import { RuntimeBrowserCommands, type RuntimeBrowserCommandHost } from './orca-runtime-browser'
import type { BrowserCookieImportResult } from '../../shared/types'

type IpcListener = (_event: unknown, reply: unknown) => void

const electronMock = vi.hoisted(() => ({
  ipcListeners: new Map<string, IpcListener[]>(),
  send: vi.fn(),
  on: vi.fn((channel: string, listener: IpcListener) => {
    const listeners = electronMock.ipcListeners.get(channel) ?? []
    listeners.push(listener)
    electronMock.ipcListeners.set(channel, listeners)
  }),
  removeListener: vi.fn((channel: string, listener: IpcListener) => {
    const listeners = electronMock.ipcListeners.get(channel) ?? []
    electronMock.ipcListeners.set(
      channel,
      listeners.filter((entry) => entry !== listener)
    )
  })
}))

const browserManagerMock = vi.hoisted(() => ({
  getWorktreeIdForTab: vi.fn(),
  getSessionProfileIdForTab: vi.fn()
}))

const browserSessionRegistryMock = vi.hoisted(() => ({
  profiles: new Map<string, { id: string; label: string; partition: string; scope: string }>(),
  getDefaultProfile: vi.fn(() => ({
    id: 'default',
    label: 'Default',
    partition: 'persist:default',
    scope: 'default'
  })),
  getProfile: vi.fn((profileId: string) => browserSessionRegistryMock.profiles.get(profileId)),
  listProfiles: vi.fn(() => [...browserSessionRegistryMock.profiles.values()]),
  createProfile: vi.fn((scope: string, label: string) => ({
    id: 'created-profile',
    label,
    partition: 'persist:created-profile',
    scope
  })),
  deleteProfile: vi.fn(async () => true),
  updateProfileSource: vi.fn(),
  clearDefaultSessionCookies: vi.fn(async () => true)
}))

const cookieImportMock = vi.hoisted(() => ({
  detectInstalledBrowsers: vi.fn<() => DetectedBrowser[]>(() => []),
  importCookiesFromBrowser: vi.fn<
    (_browser: DetectedBrowser, _targetPartition: string) => Promise<BrowserCookieImportResult>
  >(async () => ({
    ok: true,
    profileId: 'profile-1',
    summary: {
      domains: [],
      importedCookies: 2,
      skippedCookies: 0,
      totalCookies: 2
    }
  })),
  selectBrowserProfile: vi.fn(
    (_browser: DetectedBrowser, _profileName?: string) => null as DetectedBrowser | null
  )
}))

const tabRegistrationMock = vi.hoisted(() => ({
  waitForTabRegistration: vi.fn(async () => undefined)
}))

vi.mock('electron', () => ({
  ipcMain: {
    on: electronMock.on,
    removeListener: electronMock.removeListener
  }
}))

vi.mock('../browser/cdp-bridge', () => ({
  BrowserError: class BrowserError extends Error {
    code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }
}))

vi.mock('../browser/browser-manager', () => ({
  browserManager: browserManagerMock
}))

vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: browserSessionRegistryMock
}))

vi.mock('../browser/browser-cookie-import', () => cookieImportMock)

vi.mock('../ipc/browser', () => tabRegistrationMock)

type BridgeMock = AgentBrowserBridge & Record<string, ReturnType<typeof vi.fn>>

function emitIpcReply(channel: string, reply: unknown): void {
  const listeners = [...(electronMock.ipcListeners.get(channel) ?? [])]
  for (const listener of listeners) {
    listener({}, reply)
  }
}

function sentPayload(channel: string): Record<string, unknown> {
  const call = [...electronMock.send.mock.calls]
    .reverse()
    .find(([sentChannel]) => sentChannel === channel)
  expect(call).toBeTruthy()
  return call![1] as Record<string, unknown>
}

function commandHost(
  bridge: AgentBrowserBridge | null,
  overrides: Partial<RuntimeBrowserCommandHost> = {}
): RuntimeBrowserCommandHost {
  const win = { webContents: { send: electronMock.send } }
  return {
    getAgentBrowserBridge: vi.fn(() => bridge),
    resolveWorktreeSelector: vi.fn(async () => ({ id: 'repo-1::/repo' })),
    getAuthoritativeWindow: vi.fn(() => win),
    getAvailableAuthoritativeWindow: vi.fn(() => win),
    ...overrides
  } as unknown as RuntimeBrowserCommandHost
}

function bridgeMock(): BridgeMock {
  const registeredTabs = new Map([
    ['page-1', 100],
    ['page-2', 200]
  ])
  const mock = {
    snapshot: vi.fn(async () => ({ snapshot: 'tree' })),
    click: vi.fn(async () => ({ clicked: true })),
    getPageInfo: vi.fn(() => ({
      browserPageId: 'page-1',
      url: 'https://after-click.test',
      title: 'After click'
    })),
    goto: vi.fn(async () => ({ url: 'https://next.test', title: 'Next' })),
    getActivePageId: vi.fn(() => 'page-1'),
    fill: vi.fn(async () => ({ filled: true })),
    type: vi.fn(async () => ({ typed: true })),
    select: vi.fn(async () => ({ selected: true })),
    scroll: vi.fn(async () => ({ scrolled: true })),
    back: vi.fn(async () => ({ url: 'https://back.test', title: 'Back' })),
    reload: vi.fn(async () => ({ url: 'https://reload.test', title: 'Reload' })),
    screenshot: vi.fn(async () => ({ data: 'png' })),
    evaluate: vi.fn(async () => ({ value: 1 })),
    tabList: vi.fn(() => ({
      tabs: [
        { browserPageId: 'page-1', url: 'https://one.test', title: 'One', active: true },
        { browserPageId: 'page-2', url: 'https://two.test', title: 'Two', active: false }
      ]
    })),
    getRegisteredTabs: vi.fn(() => registeredTabs),
    tabSwitch: vi.fn(async () => ({ browserPageId: 'page-2' })),
    hover: vi.fn(async () => ({ hovered: true })),
    drag: vi.fn(async () => ({ dragged: true })),
    upload: vi.fn(async () => ({ uploaded: true })),
    wait: vi.fn(async () => ({ waited: true })),
    check: vi.fn(async () => ({ checked: true })),
    focus: vi.fn(async () => ({ focused: true })),
    clear: vi.fn(async () => ({ cleared: true })),
    selectAll: vi.fn(async () => ({ selectedAll: true })),
    keypress: vi.fn(async () => ({ pressed: true })),
    pdf: vi.fn(async () => ({ data: 'pdf' })),
    fullPageScreenshot: vi.fn(async () => ({ data: 'full' })),
    cookieGet: vi.fn(async () => ({ cookies: [] })),
    cookieSet: vi.fn(async () => ({ ok: true })),
    cookieDelete: vi.fn(async () => ({ deleted: true })),
    setViewport: vi.fn(async () => ({ ok: true })),
    setGeolocation: vi.fn(async () => ({ ok: true })),
    interceptEnable: vi.fn(async () => ({ enabled: true })),
    interceptDisable: vi.fn(async () => ({ disabled: true })),
    interceptList: vi.fn(async () => ({ requests: [] })),
    captureStart: vi.fn(async () => ({ started: true })),
    captureStop: vi.fn(async () => ({ stopped: true })),
    consoleLog: vi.fn(async () => ({ entries: [] })),
    networkLog: vi.fn(async () => ({ requests: [] })),
    dblclick: vi.fn(async () => ({ dblclicked: true })),
    forward: vi.fn(async () => ({ forwarded: true })),
    scrollIntoView: vi.fn(async () => ({ visible: true })),
    get: vi.fn(async () => ({ value: 'text' })),
    is: vi.fn(async () => ({ value: true })),
    keyboardInsertText: vi.fn(async () => ({ inserted: true })),
    mouseMove: vi.fn(async () => ({ moved: true })),
    mouseDown: vi.fn(async () => ({ down: true })),
    mouseUp: vi.fn(async () => ({ up: true })),
    mouseWheel: vi.fn(async () => ({ wheeled: true })),
    find: vi.fn(async () => ({ found: true })),
    setDevice: vi.fn(async () => ({ ok: true })),
    setOffline: vi.fn(async () => ({ ok: true })),
    setHeaders: vi.fn(async () => ({ ok: true })),
    setCredentials: vi.fn(async () => ({ ok: true })),
    setMedia: vi.fn(async () => ({ ok: true })),
    clipboardRead: vi.fn(async () => ({ text: 'clip' })),
    clipboardWrite: vi.fn(async () => ({ ok: true })),
    dialogAccept: vi.fn(async () => ({ accepted: true })),
    dialogDismiss: vi.fn(async () => ({ dismissed: true })),
    storageLocalGet: vi.fn(async () => ({ value: 'one' })),
    storageLocalSet: vi.fn(async () => ({ ok: true })),
    storageLocalClear: vi.fn(async () => ({ ok: true })),
    storageSessionGet: vi.fn(async () => ({ value: 'two' })),
    storageSessionSet: vi.fn(async () => ({ ok: true })),
    storageSessionClear: vi.fn(async () => ({ ok: true })),
    download: vi.fn(async () => ({ downloaded: true })),
    highlight: vi.fn(async () => ({ highlighted: true })),
    exec: vi.fn(async () => ({ ok: true })),
    setActiveTab: vi.fn(),
    getActiveWebContentsId: vi.fn(() => 100)
  }
  return mock as unknown as BridgeMock
}

describe('RuntimeBrowserCommands', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    electronMock.ipcListeners.clear()
    browserSessionRegistryMock.profiles.clear()
    browserSessionRegistryMock.profiles.set('profile-1', {
      id: 'profile-1',
      label: 'Imported',
      partition: 'persist:profile-1',
      scope: 'imported'
    })
    browserManagerMock.getWorktreeIdForTab.mockReturnValue('repo-1::/repo')
    browserManagerMock.getSessionProfileIdForTab.mockReturnValue('profile-1')
    cookieImportMock.detectInstalledBrowsers.mockReturnValue([])
    cookieImportMock.importCookiesFromBrowser.mockResolvedValue({
      ok: true,
      profileId: 'profile-1',
      summary: {
        domains: [],
        importedCookies: 2,
        skippedCookies: 0,
        totalCookies: 2
      }
    })
    cookieImportMock.selectBrowserProfile.mockReset()
    tabRegistrationMock.waitForTabRegistration.mockResolvedValue(undefined)
  })

  it('routes browser automation commands to the bridge with explicit page targets', async () => {
    const bridge = bridgeMock()
    const commands = new RuntimeBrowserCommands(commandHost(bridge))
    const cases: {
      command: string
      params: Record<string, unknown>
      bridgeMethod: string
      expected: unknown[]
    }[] = [
      {
        command: 'browserSnapshot',
        params: { page: 'page-1' },
        bridgeMethod: 'snapshot',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserClick',
        params: { page: 'page-1', element: '@button' },
        bridgeMethod: 'click',
        expected: ['@button', undefined, 'page-1']
      },
      {
        command: 'browserGoto',
        params: { page: 'page-1', url: 'https://next.test' },
        bridgeMethod: 'goto',
        expected: ['https://next.test', undefined, 'page-1']
      },
      {
        command: 'browserFill',
        params: { page: 'page-1', element: '@input', value: 'value' },
        bridgeMethod: 'fill',
        expected: ['@input', 'value', undefined, 'page-1']
      },
      {
        command: 'browserType',
        params: { page: 'page-1', input: 'hello' },
        bridgeMethod: 'type',
        expected: ['hello', undefined, 'page-1']
      },
      {
        command: 'browserSelect',
        params: { page: 'page-1', element: '@select', value: 'a' },
        bridgeMethod: 'select',
        expected: ['@select', 'a', undefined, 'page-1']
      },
      {
        command: 'browserScroll',
        params: { page: 'page-1', direction: 'down', amount: 40 },
        bridgeMethod: 'scroll',
        expected: ['down', 40, undefined, 'page-1']
      },
      {
        command: 'browserBack',
        params: { page: 'page-1' },
        bridgeMethod: 'back',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserReload',
        params: { page: 'page-1' },
        bridgeMethod: 'reload',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserScreenshot',
        params: { page: 'page-1', format: 'jpeg' },
        bridgeMethod: 'screenshot',
        expected: ['jpeg', undefined, 'page-1']
      },
      {
        command: 'browserEval',
        params: { page: 'page-1', expression: '1 + 1' },
        bridgeMethod: 'evaluate',
        expected: ['1 + 1', undefined, 'page-1']
      },
      {
        command: 'browserHover',
        params: { page: 'page-1', element: '@link' },
        bridgeMethod: 'hover',
        expected: ['@link', undefined, 'page-1']
      },
      {
        command: 'browserDrag',
        params: { page: 'page-1', from: '@a', to: '@b' },
        bridgeMethod: 'drag',
        expected: ['@a', '@b', undefined, 'page-1']
      },
      {
        command: 'browserUpload',
        params: { page: 'page-1', element: '@file', files: ['/tmp/a.txt'] },
        bridgeMethod: 'upload',
        expected: ['@file', ['/tmp/a.txt'], undefined, 'page-1']
      },
      {
        command: 'browserWait',
        params: { page: 'page-1', selector: '.ready', timeout: 10 },
        bridgeMethod: 'wait',
        expected: [{ selector: '.ready', timeout: 10 }, undefined, 'page-1']
      },
      {
        command: 'browserCheck',
        params: { page: 'page-1', element: '@box', checked: true },
        bridgeMethod: 'check',
        expected: ['@box', true, undefined, 'page-1']
      },
      {
        command: 'browserFocus',
        params: { page: 'page-1', element: '@input' },
        bridgeMethod: 'focus',
        expected: ['@input', undefined, 'page-1']
      },
      {
        command: 'browserClear',
        params: { page: 'page-1', element: '@input' },
        bridgeMethod: 'clear',
        expected: ['@input', undefined, 'page-1']
      },
      {
        command: 'browserSelectAll',
        params: { page: 'page-1', element: '@input' },
        bridgeMethod: 'selectAll',
        expected: ['@input', undefined, 'page-1']
      },
      {
        command: 'browserKeypress',
        params: { page: 'page-1', key: 'Enter' },
        bridgeMethod: 'keypress',
        expected: ['Enter', undefined, 'page-1']
      },
      {
        command: 'browserPdf',
        params: { page: 'page-1' },
        bridgeMethod: 'pdf',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserFullScreenshot',
        params: { page: 'page-1', format: 'png' },
        bridgeMethod: 'fullPageScreenshot',
        expected: ['png', undefined, 'page-1']
      },
      {
        command: 'browserCookieGet',
        params: { page: 'page-1', url: 'https://one.test' },
        bridgeMethod: 'cookieGet',
        expected: ['https://one.test', undefined, 'page-1']
      },
      {
        command: 'browserCookieSet',
        params: { page: 'page-1', name: 'sid', value: '1', domain: 'one.test' },
        bridgeMethod: 'cookieSet',
        expected: [
          { page: 'page-1', name: 'sid', value: '1', domain: 'one.test' },
          undefined,
          'page-1'
        ]
      },
      {
        command: 'browserCookieDelete',
        params: { page: 'page-1', name: 'sid', domain: 'one.test', url: 'https://one.test' },
        bridgeMethod: 'cookieDelete',
        expected: ['sid', 'one.test', 'https://one.test', undefined, 'page-1']
      },
      {
        command: 'browserSetViewport',
        params: { page: 'page-1', width: 800, height: 600, deviceScaleFactor: 2, mobile: true },
        bridgeMethod: 'setViewport',
        expected: [800, 600, 2, true, undefined, 'page-1']
      },
      {
        command: 'browserSetGeolocation',
        params: { page: 'page-1', latitude: 1, longitude: 2, accuracy: 3 },
        bridgeMethod: 'setGeolocation',
        expected: [1, 2, 3, undefined, 'page-1']
      },
      {
        command: 'browserInterceptEnable',
        params: { page: 'page-1', patterns: ['**/*'] },
        bridgeMethod: 'interceptEnable',
        expected: [['**/*'], undefined, 'page-1']
      },
      {
        command: 'browserInterceptDisable',
        params: { page: 'page-1' },
        bridgeMethod: 'interceptDisable',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserInterceptList',
        params: { page: 'page-1' },
        bridgeMethod: 'interceptList',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserCaptureStart',
        params: { page: 'page-1' },
        bridgeMethod: 'captureStart',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserCaptureStop',
        params: { page: 'page-1' },
        bridgeMethod: 'captureStop',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserConsoleLog',
        params: { page: 'page-1', limit: 5 },
        bridgeMethod: 'consoleLog',
        expected: [5, undefined, 'page-1']
      },
      {
        command: 'browserNetworkLog',
        params: { page: 'page-1', limit: 6 },
        bridgeMethod: 'networkLog',
        expected: [6, undefined, 'page-1']
      },
      {
        command: 'browserDblclick',
        params: { page: 'page-1', element: '@button' },
        bridgeMethod: 'dblclick',
        expected: ['@button', undefined, 'page-1']
      },
      {
        command: 'browserForward',
        params: { page: 'page-1' },
        bridgeMethod: 'forward',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserScrollIntoView',
        params: { page: 'page-1', element: '@row' },
        bridgeMethod: 'scrollIntoView',
        expected: ['@row', undefined, 'page-1']
      },
      {
        command: 'browserGet',
        params: { page: 'page-1', what: 'text', selector: '@row' },
        bridgeMethod: 'get',
        expected: ['text', '@row', undefined, 'page-1']
      },
      {
        command: 'browserIs',
        params: { page: 'page-1', what: 'visible', selector: '@row' },
        bridgeMethod: 'is',
        expected: ['visible', '@row', undefined, 'page-1']
      },
      {
        command: 'browserKeyboardInsertText',
        params: { page: 'page-1', text: 'paste' },
        bridgeMethod: 'keyboardInsertText',
        expected: ['paste', undefined, 'page-1']
      },
      {
        command: 'browserMouseMove',
        params: { page: 'page-1', x: 10, y: 20 },
        bridgeMethod: 'mouseMove',
        expected: [10, 20, undefined, 'page-1']
      },
      {
        command: 'browserMouseDown',
        params: { page: 'page-1', button: 'left' },
        bridgeMethod: 'mouseDown',
        expected: ['left', undefined, 'page-1']
      },
      {
        command: 'browserMouseUp',
        params: { page: 'page-1', button: 'left' },
        bridgeMethod: 'mouseUp',
        expected: ['left', undefined, 'page-1']
      },
      {
        command: 'browserMouseWheel',
        params: { page: 'page-1', dy: 120, dx: 5 },
        bridgeMethod: 'mouseWheel',
        expected: [120, 5, undefined, 'page-1']
      },
      {
        command: 'browserFind',
        params: { page: 'page-1', locator: 'role', value: 'button', action: 'click', text: 'Save' },
        bridgeMethod: 'find',
        expected: ['role', 'button', 'click', 'Save', undefined, 'page-1']
      },
      {
        command: 'browserSetDevice',
        params: { page: 'page-1', name: 'iPhone 15' },
        bridgeMethod: 'setDevice',
        expected: ['iPhone 15', undefined, 'page-1']
      },
      {
        command: 'browserSetOffline',
        params: { page: 'page-1', state: 'true' },
        bridgeMethod: 'setOffline',
        expected: ['true', undefined, 'page-1']
      },
      {
        command: 'browserSetHeaders',
        params: { page: 'page-1', headers: '{"x":"y"}' },
        bridgeMethod: 'setHeaders',
        expected: ['{"x":"y"}', undefined, 'page-1']
      },
      {
        command: 'browserSetCredentials',
        params: { page: 'page-1', user: 'u', pass: 'p' },
        bridgeMethod: 'setCredentials',
        expected: ['u', 'p', undefined, 'page-1']
      },
      {
        command: 'browserSetMedia',
        params: { page: 'page-1', colorScheme: 'dark', reducedMotion: 'reduce' },
        bridgeMethod: 'setMedia',
        expected: ['dark', 'reduce', undefined, 'page-1']
      },
      {
        command: 'browserClipboardRead',
        params: { page: 'page-1' },
        bridgeMethod: 'clipboardRead',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserClipboardWrite',
        params: { page: 'page-1', text: 'copy' },
        bridgeMethod: 'clipboardWrite',
        expected: ['copy', undefined, 'page-1']
      },
      {
        command: 'browserDialogAccept',
        params: { page: 'page-1', text: 'ok' },
        bridgeMethod: 'dialogAccept',
        expected: ['ok', undefined, 'page-1']
      },
      {
        command: 'browserDialogDismiss',
        params: { page: 'page-1' },
        bridgeMethod: 'dialogDismiss',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserStorageLocalGet',
        params: { page: 'page-1', key: 'k' },
        bridgeMethod: 'storageLocalGet',
        expected: ['k', undefined, 'page-1']
      },
      {
        command: 'browserStorageLocalSet',
        params: { page: 'page-1', key: 'k', value: 'v' },
        bridgeMethod: 'storageLocalSet',
        expected: ['k', 'v', undefined, 'page-1']
      },
      {
        command: 'browserStorageLocalClear',
        params: { page: 'page-1' },
        bridgeMethod: 'storageLocalClear',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserStorageSessionGet',
        params: { page: 'page-1', key: 'k' },
        bridgeMethod: 'storageSessionGet',
        expected: ['k', undefined, 'page-1']
      },
      {
        command: 'browserStorageSessionSet',
        params: { page: 'page-1', key: 'k', value: 'v' },
        bridgeMethod: 'storageSessionSet',
        expected: ['k', 'v', undefined, 'page-1']
      },
      {
        command: 'browserStorageSessionClear',
        params: { page: 'page-1' },
        bridgeMethod: 'storageSessionClear',
        expected: [undefined, 'page-1']
      },
      {
        command: 'browserDownload',
        params: { page: 'page-1', selector: '@download', path: '/tmp/file.txt' },
        bridgeMethod: 'download',
        expected: ['@download', '/tmp/file.txt', undefined, 'page-1']
      },
      {
        command: 'browserHighlight',
        params: { page: 'page-1', selector: '@row' },
        bridgeMethod: 'highlight',
        expected: ['@row', undefined, 'page-1']
      },
      {
        command: 'browserExec',
        params: { page: 'page-1', command: 'document.title' },
        bridgeMethod: 'exec',
        expected: ['document.title', undefined, 'page-1']
      }
    ]

    for (const testCase of cases) {
      bridge[testCase.bridgeMethod].mockClear()
      await (commands as unknown as Record<string, (params: unknown) => Promise<unknown>>)[
        testCase.command
      ](testCase.params)
      expect(bridge[testCase.bridgeMethod]).toHaveBeenCalledWith(...testCase.expected)
    }

    expect(electronMock.send).toHaveBeenCalledWith('browser:navigation-update', {
      browserPageId: 'page-1',
      url: 'https://next.test',
      title: 'Next'
    })
  })

  it('activates the renderer browser pane when a selected worktree has not mounted tabs yet', async () => {
    vi.useFakeTimers()
    const bridge = bridgeMock()
    vi.mocked(bridge.getRegisteredTabs).mockReturnValue(new Map())
    const commands = new RuntimeBrowserCommands(commandHost(bridge))

    const pending = commands.browserSnapshot({ worktree: 'path:/repo' })
    await vi.advanceTimersByTimeAsync(500)
    await pending

    expect(electronMock.send).toHaveBeenCalledWith('ui:activateWorktree', {
      repoId: 'repo-1',
      worktreeId: 'repo-1::/repo'
    })
    expect(electronMock.send).toHaveBeenCalledWith('browser:activateView', {
      worktreeId: 'repo-1::/repo'
    })
    expect(bridge.snapshot).toHaveBeenCalledWith('repo-1::/repo', undefined)
  })

  it('requires an active bridge before dispatching commands', async () => {
    const commands = new RuntimeBrowserCommands(commandHost(null))

    await expect(commands.browserSnapshot({})).rejects.toMatchObject({
      code: 'browser_no_tab',
      message: 'No browser session is active'
    })
  })

  it('enriches tab listing, show, current, and focused switch results', async () => {
    const bridge = bridgeMock()
    const commands = new RuntimeBrowserCommands(commandHost(bridge))

    await expect(commands.browserTabList({ worktree: 'path:/repo' })).resolves.toEqual({
      tabs: [
        expect.objectContaining({
          browserPageId: 'page-1',
          worktreeId: 'repo-1::/repo',
          profileId: 'profile-1',
          profileLabel: 'Imported'
        }),
        expect.objectContaining({ browserPageId: 'page-2' })
      ]
    })
    await expect(
      commands.browserTabShow({ page: 'page-1', worktree: 'path:/repo' })
    ).resolves.toEqual({
      tab: expect.objectContaining({ browserPageId: 'page-1', profileLabel: 'Imported' })
    })
    await expect(commands.browserTabCurrent({ worktree: 'path:/repo' })).resolves.toEqual({
      tab: expect.objectContaining({ browserPageId: 'page-1' })
    })
    await expect(
      commands.browserTabSwitch({ worktree: 'path:/repo', index: 1, focus: true })
    ).resolves.toEqual({
      browserPageId: 'page-2'
    })

    expect(bridge.tabList).toHaveBeenCalledWith('repo-1::/repo')
    expect(electronMock.send).toHaveBeenCalledWith('browser:pane-focus', {
      worktreeId: 'repo-1::/repo',
      browserPageId: 'page-2'
    })
  })

  it('creates browser tabs through renderer IPC and activates registered guests', async () => {
    const bridge = bridgeMock()
    vi.mocked(bridge.getRegisteredTabs).mockReturnValue(new Map([['created-page', 909]]))
    const commands = new RuntimeBrowserCommands(commandHost(bridge))

    const pending = commands.browserTabCreate({
      url: 'https://created.test',
      profileId: 'profile-1'
    })
    const createPayload = sentPayload('browser:requestTabCreate')
    emitIpcReply('browser:tabCreateReply', {
      requestId: createPayload.requestId,
      browserPageId: 'created-page'
    })

    await expect(pending).resolves.toEqual({ browserPageId: 'created-page' })
    expect(waitForTabRegistration).toHaveBeenCalledWith('created-page')
    expect(bridge.setActiveTab).toHaveBeenCalledWith(909, undefined)
    expect(bridge.goto).toHaveBeenCalledWith('https://created.test', undefined, 'created-page')
    expect(electronMock.send).toHaveBeenCalledWith('browser:navigation-update', {
      browserPageId: 'created-page',
      url: 'https://next.test',
      title: 'Next'
    })
  })

  it('rejects browser tab creation when no desktop renderer is available', async () => {
    const commands = new RuntimeBrowserCommands(
      commandHost(bridgeMock(), { getAvailableAuthoritativeWindow: vi.fn(() => null) })
    )

    await expect(commands.browserTabCreate({ url: 'https://created.test' })).rejects.toMatchObject({
      code: 'browser_error'
    })
  })

  it('sets and clones tab profiles through renderer IPC', async () => {
    const bridge = bridgeMock()
    const commands = new RuntimeBrowserCommands(commandHost(bridge))

    browserManagerMock.getSessionProfileIdForTab.mockReturnValue('default')
    const setPending = commands.browserTabSetProfile({ page: 'page-1', profileId: 'profile-1' })
    await Promise.resolve()
    const setPayload = sentPayload('browser:requestTabSetProfile')
    emitIpcReply('browser:tabSetProfileReply', { requestId: setPayload.requestId })

    await expect(setPending).resolves.toEqual({
      browserPageId: 'page-1',
      profileId: 'profile-1',
      profileLabel: 'Imported'
    })
    expect(waitForTabRegistration).toHaveBeenCalledWith('page-1')

    browserManagerMock.getSessionProfileIdForTab.mockReturnValue('profile-1')
    await expect(
      commands.browserTabSetProfile({ page: 'page-1', profileId: 'profile-1' })
    ).resolves.toEqual({
      browserPageId: 'page-1',
      profileId: 'profile-1',
      profileLabel: 'Imported'
    })

    browserManagerMock.getWorktreeIdForTab.mockReturnValue(undefined)
    const clonePending = commands.browserTabProfileClone({ page: 'page-1', profileId: 'profile-1' })
    await Promise.resolve()
    const clonePayload = sentPayload('browser:requestTabCreate')
    emitIpcReply('browser:tabCreateReply', {
      requestId: clonePayload.requestId,
      browserPageId: 'cloned-page'
    })

    await expect(clonePending).resolves.toEqual({
      browserPageId: 'cloned-page',
      sourceBrowserPageId: 'page-1',
      profileId: 'profile-1',
      profileLabel: 'Imported'
    })
  })

  it('rejects unknown profile ids for tab profile commands', async () => {
    const commands = new RuntimeBrowserCommands(commandHost(bridgeMock()))

    await expect(
      commands.browserTabSetProfile({ page: 'page-1', profileId: 'missing' })
    ).rejects.toMatchObject({
      code: 'invalid_argument'
    })
    await expect(
      commands.browserTabProfileClone({ page: 'page-1', profileId: 'missing' })
    ).rejects.toMatchObject({
      code: 'invalid_argument'
    })
  })

  it('manages browser profiles and imports cookies from selected browser profiles', async () => {
    const commands = new RuntimeBrowserCommands(commandHost(bridgeMock()))
    const browser: DetectedBrowser = {
      family: 'chrome',
      label: 'Chrome',
      selectedProfile: 'Default',
      profiles: [
        { directory: 'Default', name: 'Default' },
        { directory: 'Profile 1', name: 'Work' }
      ],
      cookiesPath: '/source/Cookies'
    }
    const reselected = {
      ...browser,
      selectedProfile: 'Profile 1',
      cookiesPath: '/source/Profile 1/Cookies'
    }
    cookieImportMock.detectInstalledBrowsers.mockReturnValue([browser])
    cookieImportMock.selectBrowserProfile.mockReturnValue(reselected)

    await expect(commands.browserProfileList()).resolves.toEqual({
      profiles: [expect.objectContaining({ id: 'profile-1' })]
    })
    await expect(
      commands.browserProfileCreate({ label: 'QA', scope: 'isolated' })
    ).resolves.toEqual({
      profile: expect.objectContaining({ id: 'created-profile', label: 'QA' })
    })
    await expect(commands.browserProfileDelete({ profileId: 'profile-1' })).resolves.toEqual({
      deleted: true,
      profileId: 'profile-1'
    })
    await expect(commands.browserProfileDetectBrowsers()).resolves.toEqual({
      browsers: [
        {
          family: 'chrome',
          label: 'Chrome',
          profiles: browser.profiles,
          selectedProfile: 'Default'
        }
      ]
    })
    await expect(
      commands.browserProfileImportFromBrowser({
        profileId: 'profile-1',
        browserFamily: 'chrome',
        browserProfile: 'Profile 1'
      })
    ).resolves.toEqual({
      ok: true,
      profileId: 'profile-1',
      summary: {
        domains: [],
        importedCookies: 2,
        skippedCookies: 0,
        totalCookies: 2
      }
    })
    await expect(commands.browserProfileClearDefaultCookies()).resolves.toEqual({ cleared: true })

    expect(selectBrowserProfile).toHaveBeenCalledWith(browser, 'Profile 1')
    expect(importCookiesFromBrowser).toHaveBeenCalledWith(reselected, 'persist:profile-1')
    expect(browserSessionRegistry.updateProfileSource).toHaveBeenCalledWith('profile-1', {
      browserFamily: 'chrome',
      profileName: 'Work',
      importedAt: expect.any(Number)
    })
  })

  it('returns profile import failures without touching the registry source', async () => {
    const commands = new RuntimeBrowserCommands(commandHost(bridgeMock()))
    const browser: DetectedBrowser = {
      family: 'chrome',
      label: 'Chrome',
      selectedProfile: 'Default',
      profiles: [{ directory: 'Default', name: 'Default' }],
      cookiesPath: '/source/Cookies'
    }

    await expect(
      commands.browserProfileImportFromBrowser({
        profileId: 'missing',
        browserFamily: 'chrome'
      })
    ).resolves.toEqual({ ok: false, reason: 'Session profile not found.' })
    await expect(
      commands.browserProfileImportFromBrowser({
        profileId: 'profile-1',
        browserFamily: 'chrome',
        browserProfile: '../Default'
      })
    ).resolves.toEqual({ ok: false, reason: 'Invalid browser profile name.' })
    await expect(
      commands.browserProfileImportFromBrowser({
        profileId: 'profile-1',
        browserFamily: 'missing'
      })
    ).resolves.toEqual({ ok: false, reason: 'Browser not found on this system.' })

    cookieImportMock.detectInstalledBrowsers.mockReturnValue([browser])
    cookieImportMock.selectBrowserProfile.mockReturnValue(null)
    await expect(
      commands.browserProfileImportFromBrowser({
        profileId: 'profile-1',
        browserFamily: 'chrome',
        browserProfile: 'Profile 2'
      })
    ).resolves.toEqual({
      ok: false,
      reason: 'No cookies database found for profile "Profile 2".'
    })

    cookieImportMock.importCookiesFromBrowser.mockResolvedValue({
      ok: false,
      reason: 'locked'
    })
    await expect(
      commands.browserProfileImportFromBrowser({
        profileId: 'profile-1',
        browserFamily: 'chrome'
      })
    ).resolves.toEqual({ ok: false, reason: 'locked' })

    expect(browserSessionRegistry.updateProfileSource).not.toHaveBeenCalled()
  })

  it('shows tab profile metadata and closes tabs by page or index', async () => {
    const bridge = bridgeMock()
    const commands = new RuntimeBrowserCommands(commandHost(bridge))

    await expect(commands.browserTabProfileShow({ page: 'page-1' })).resolves.toEqual({
      browserPageId: 'page-1',
      worktreeId: 'repo-1::/repo',
      profileId: 'profile-1',
      profileLabel: 'Imported'
    })

    const closeByPage = commands.browserTabClose({ page: 'page-1' })
    await Promise.resolve()
    const pagePayload = sentPayload('browser:requestTabClose')
    emitIpcReply('browser:tabCloseReply', { requestId: pagePayload.requestId })
    await expect(closeByPage).resolves.toEqual({ closed: true })
    expect(pagePayload).toEqual(expect.objectContaining({ tabId: 'page-1', worktreeId: undefined }))

    const closeByIndex = commands.browserTabClose({ index: 1 })
    await Promise.resolve()
    const indexPayload = sentPayload('browser:requestTabClose')
    emitIpcReply('browser:tabCloseReply', { requestId: indexPayload.requestId })
    await expect(closeByIndex).resolves.toEqual({ closed: true })
    expect(indexPayload).toEqual(
      expect.objectContaining({ tabId: 'page-2', worktreeId: undefined })
    )

    await expect(commands.browserTabClose({ page: 'missing' })).rejects.toMatchObject({
      code: 'browser_tab_not_found'
    })
    await expect(commands.browserTabClose({ index: 9 })).rejects.toThrow('Tab index 9 out of range')
  })
})
