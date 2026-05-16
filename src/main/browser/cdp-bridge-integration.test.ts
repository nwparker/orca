/* eslint-disable max-lines -- Why: integration test covering the full browser automation pipeline end-to-end. */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createConnection } from 'net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── Electron mocks ──

const { webContentsFromIdMock } = vi.hoisted(() => ({
  webContentsFromIdMock: vi.fn()
}))

vi.mock('electron', () => ({
  webContents: { fromId: webContentsFromIdMock },
  shell: { openExternal: vi.fn() },
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn(), on: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false }
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([])
}))

import { BrowserManager } from './browser-manager'
import { CdpBridge } from './cdp-bridge'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { readRuntimeMetadata } from '../runtime/runtime-metadata'

// ── CDP response builders ──

type AXNode = {
  nodeId: string
  backendDOMNodeId?: number
  role?: { type: string; value: string }
  name?: { type: string; value: string }
  properties?: { name: string; value: { type: string; value: unknown } }[]
  childIds?: string[]
  ignored?: boolean
}

function axNode(
  id: string,
  role: string,
  name: string,
  opts?: { childIds?: string[]; backendDOMNodeId?: number }
): AXNode {
  return {
    nodeId: id,
    backendDOMNodeId: opts?.backendDOMNodeId ?? parseInt(id, 10) * 100,
    role: { type: 'role', value: role },
    name: { type: 'computedString', value: name },
    childIds: opts?.childIds
  }
}

const EXAMPLE_COM_TREE: AXNode[] = [
  axNode('1', 'WebArea', 'Example Domain', { childIds: ['2', '3', '4'] }),
  axNode('2', 'heading', 'Example Domain'),
  axNode('3', 'staticText', 'This domain is for use in illustrative examples.'),
  axNode('4', 'link', 'More information...', { backendDOMNodeId: 400 })
]

const SEARCH_PAGE_TREE: AXNode[] = [
  axNode('1', 'WebArea', 'Search', { childIds: ['2', '3', '4', '5'] }),
  axNode('2', 'navigation', 'Main Nav', { childIds: ['3'] }),
  axNode('3', 'link', 'Home', { backendDOMNodeId: 300 }),
  axNode('4', 'textbox', 'Search query', { backendDOMNodeId: 400 }),
  axNode('5', 'button', 'Search', { backendDOMNodeId: 500 })
]

// ── Mock WebContents factory ──

function createMockGuest(id: number, url: string, title: string) {
  let currentUrl = url
  let currentTitle = title
  let currentTree = EXAMPLE_COM_TREE
  let navHistoryId = 1
  let history = [{ id: navHistoryId, url: currentUrl }]
  let currentHistoryIndex = 0

  const sendCommandMock = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    switch (method) {
      case 'Page.enable':
      case 'DOM.enable':
      case 'Accessibility.enable':
      case 'Runtime.enable':
      case 'Network.enable':
      case 'Fetch.enable':
      case 'Fetch.disable':
      case 'Emulation.setDeviceMetricsOverride':
      case 'Emulation.setGeolocationOverride':
      case 'Network.deleteCookies':
        return {}
      case 'Accessibility.getFullAXTree':
        return { nodes: currentTree }
      case 'Page.getNavigationHistory':
        return {
          entries: history,
          currentIndex: currentHistoryIndex
        }
      case 'Page.navigate': {
        const targetUrl = (params as { url: string }).url
        if (targetUrl.includes('nonexistent.invalid')) {
          return { errorText: 'net::ERR_NAME_NOT_RESOLVED' }
        }
        navHistoryId++
        history = history.slice(0, currentHistoryIndex + 1)
        history.push({ id: navHistoryId, url: targetUrl })
        currentHistoryIndex = history.length - 1
        currentUrl = targetUrl
        if (targetUrl.includes('search.example.com')) {
          currentTitle = 'Search'
          currentTree = SEARCH_PAGE_TREE
        } else {
          currentTitle = 'Example Domain'
          currentTree = EXAMPLE_COM_TREE
        }
        return {}
      }
      case 'Page.navigateToHistoryEntry': {
        const entryId = (params as { entryId: number }).entryId
        const index = history.findIndex((entry) => entry.id === entryId)
        if (index >= 0) {
          currentHistoryIndex = index
          currentUrl = history[index]!.url
          currentTitle = currentUrl.includes('search.example.com') ? 'Search' : 'Example Domain'
          currentTree = currentUrl.includes('search.example.com')
            ? SEARCH_PAGE_TREE
            : EXAMPLE_COM_TREE
        }
        return {}
      }
      case 'Runtime.evaluate': {
        const expr = (params as { expression: string }).expression
        if (expr === 'document.readyState') {
          return { result: { value: 'complete' } }
        }
        if (expr === 'location.origin') {
          return { result: { value: new URL(currentUrl).origin } }
        }
        if (expr === 'location.hostname') {
          return { result: { value: new URL(currentUrl).hostname } }
        }
        if (expr === 'location.href') {
          return { result: { value: currentUrl } }
        }
        if (expr === 'throw new Error("boom")') {
          return {
            result: { type: 'undefined' },
            exceptionDetails: { text: 'boom', exception: { description: 'Error: boom' } }
          }
        }
        if (expr.includes('innerWidth')) {
          return { result: { value: JSON.stringify({ w: 1280, h: 720 }) } }
        }
        if (expr.includes('scrollBy')) {
          return { result: { value: undefined } }
        }
        if (expr.includes('dispatchEvent')) {
          return { result: { value: undefined } }
        }
        // eslint-disable-next-line no-eval
        return { result: { value: String(eval(expr)), type: 'string' } }
      }
      case 'DOM.scrollIntoViewIfNeeded':
        return {}
      case 'DOM.getBoxModel':
        return { model: { content: [100, 200, 300, 200, 300, 250, 100, 250] } }
      case 'Input.dispatchMouseEvent':
        return {}
      case 'Input.insertText':
        return {}
      case 'Input.dispatchKeyEvent':
        return {}
      case 'DOM.focus':
        return {}
      case 'DOM.describeNode':
        return { node: { nodeId: 1 } }
      case 'DOM.requestNode':
        return { nodeId: 1 }
      case 'DOM.resolveNode':
        return { object: { objectId: 'obj-1' } }
      case 'Runtime.callFunctionOn':
        if (
          (params as { functionDeclaration?: string }).functionDeclaration?.includes(
            'return this.checked'
          )
        ) {
          return { result: { value: false } }
        }
        return { result: { value: undefined } }
      case 'DOM.setFileInputFiles':
        return {}
      case 'Page.captureScreenshot':
        return {
          data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
        }
      case 'Page.getLayoutMetrics':
        return { cssContentSize: { width: 1024, height: 2048 } }
      case 'Page.printToPDF':
        return { data: 'JVBERi0xLjQKJQ==' }
      case 'Network.getCookies':
        return {
          cookies: [
            {
              name: 'sid',
              value: 'abc',
              domain: 'example.com',
              path: '/',
              secure: true,
              httpOnly: true,
              sameSite: 'Lax'
            }
          ]
        }
      case 'Network.setCookie':
        return { success: true }
      case 'Page.reload':
        return {}
      case 'Target.setAutoAttach':
        return {}
      case 'Page.addScriptToEvaluateOnNewDocument':
        return { identifier: 'mock-script-id' }
      default:
        throw new Error(`Unexpected CDP method: ${method}`)
    }
  })

  const debuggerListeners = new Map<string, ((...args: unknown[]) => void)[]>()

  const guest = {
    id,
    isDestroyed: vi.fn(() => false),
    getType: vi.fn(() => 'webview'),
    getURL: vi.fn(() => currentUrl),
    getTitle: vi.fn(() => currentTitle),
    setBackgroundThrottling: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: sendCommandMock,
      on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const handlers = debuggerListeners.get(event) ?? []
        handlers.push(handler)
        debuggerListeners.set(event, handlers)
      }),
      removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
        const handlers = debuggerListeners.get(event) ?? []
        const idx = handlers.indexOf(handler)
        if (idx >= 0) {
          handlers.splice(idx, 1)
        }
      }),
      removeAllListeners: vi.fn((event: string) => {
        debuggerListeners.set(event, [])
      }),
      off: vi.fn()
    }
  }

  const emitDebuggerMessage = (method: string, params?: unknown): void => {
    for (const handler of debuggerListeners.get('message') ?? []) {
      handler({}, method, params)
    }
  }

  return { guest, sendCommandMock, emitDebuggerMessage }
}

// ── RPC helper ──

async function sendRequest(
  endpoint: string,
  request: Record<string, unknown>
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('error', reject)
    socket.on('data', (chunk) => {
      buffer += chunk
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      const message = buffer.slice(0, newlineIndex)
      socket.end()
      resolve(JSON.parse(message) as Record<string, unknown>)
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`)
    })
  })
}

// ── Tests ──

describe('Browser automation pipeline (integration)', () => {
  let server: OrcaRuntimeRpcServer
  let endpoint: string
  let authToken: string

  const GUEST_WC_ID = 5001
  const RENDERER_WC_ID = 1

  beforeEach(async () => {
    const { guest } = createMockGuest(GUEST_WC_ID, 'https://example.com', 'Example Domain')
    webContentsFromIdMock.mockImplementation((id: number) => {
      if (id === GUEST_WC_ID) {
        return guest
      }
      return null
    })

    const browserManager = new BrowserManager()
    // Simulate the attach-time policy (normally done in will-attach-webview)
    browserManager.attachGuestPolicies(guest as never)
    browserManager.registerGuest({
      browserPageId: 'page-1',
      webContentsId: GUEST_WC_ID,
      rendererWebContentsId: RENDERER_WC_ID
    })

    const cdpBridge = new CdpBridge(browserManager)
    cdpBridge.setActiveTab(GUEST_WC_ID)

    const userDataPath = mkdtempSync(join(tmpdir(), 'browser-e2e-'))
    const runtime = new OrcaRuntimeService()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime.setAgentBrowserBridge(cdpBridge as any)

    server = new OrcaRuntimeRpcServer({ runtime, userDataPath })
    await server.start()

    const metadata = readRuntimeMetadata(userDataPath)!
    endpoint = metadata.transports[0]!.endpoint
    authToken = metadata.authToken!
  })

  afterEach(async () => {
    await server.stop()
  })

  async function rpc(method: string, params?: Record<string, unknown>) {
    const response = await sendRequest(endpoint, {
      id: `req_${method}`,
      authToken,
      method,
      ...(params ? { params } : {})
    })
    return response
  }

  // ── Snapshot ──

  it('takes a snapshot and returns refs for interactive elements', async () => {
    const res = await rpc('browser.snapshot')
    expect(res.ok).toBe(true)

    const result = res.result as {
      snapshot: string
      refs: { ref: string; role: string; name: string }[]
      url: string
      title: string
    }
    expect(result.url).toBe('https://example.com')
    expect(result.title).toBe('Example Domain')
    expect(result.snapshot).toContain('heading "Example Domain"')
    expect(result.snapshot).toContain('link "More information..."')
    expect(result.refs).toHaveLength(1)
    expect(result.refs[0]).toMatchObject({
      ref: '@e1',
      role: 'link',
      name: 'More information...'
    })
  })

  // ── Click ──

  it('clicks an element by ref after snapshot', async () => {
    await rpc('browser.snapshot')

    const res = await rpc('browser.click', { element: '@e1' })
    expect(res.ok).toBe(true)
    expect((res.result as { clicked: string }).clicked).toBe('@e1')
  })

  it('returns error when clicking without a prior snapshot', async () => {
    const res = await rpc('browser.click', { element: '@e1' })
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_stale_ref')
  })

  it('returns error for non-existent ref', async () => {
    await rpc('browser.snapshot')

    const res = await rpc('browser.click', { element: '@e999' })
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_ref_not_found')
  })

  // ── Navigation ──

  it('navigates to a URL and invalidates refs', async () => {
    await rpc('browser.snapshot')

    const gotoRes = await rpc('browser.goto', { url: 'https://search.example.com' })
    expect(gotoRes.ok).toBe(true)
    const gotoResult = gotoRes.result as { url: string; title: string }
    expect(gotoResult.url).toBe('https://search.example.com')
    expect(gotoResult.title).toBe('Search')

    // Old refs should be stale after navigation
    const clickRes = await rpc('browser.click', { element: '@e1' })
    expect(clickRes.ok).toBe(false)
    expect((clickRes.error as { code: string }).code).toBe('browser_stale_ref')

    // Re-snapshot should work and show new page
    const snapRes = await rpc('browser.snapshot')
    expect(snapRes.ok).toBe(true)
    const snapResult = snapRes.result as { snapshot: string; refs: { name: string }[] }
    expect(snapResult.snapshot).toContain('Search')
    expect(snapResult.refs.map((r) => r.name)).toContain('Search')
    expect(snapResult.refs.map((r) => r.name)).toContain('Home')
  })

  it('returns error for failed navigation', async () => {
    const res = await rpc('browser.goto', { url: 'https://nonexistent.invalid' })
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_navigation_failed')
  })

  // ── Fill ──

  it('fills an input by ref', async () => {
    await rpc('browser.goto', { url: 'https://search.example.com' })
    await rpc('browser.snapshot')

    // @e2 should be the textbox "Search query" on the search page
    const res = await rpc('browser.fill', { element: '@e2', value: 'hello world' })
    expect(res.ok).toBe(true)
    expect((res.result as { filled: string }).filled).toBe('@e2')
  })

  // ── Type ──

  it('types text at current focus', async () => {
    const res = await rpc('browser.type', { input: 'some text' })
    expect(res.ok).toBe(true)
    expect((res.result as { typed: boolean }).typed).toBe(true)
  })

  // ── Select ──

  it('selects a dropdown option by ref', async () => {
    await rpc('browser.goto', { url: 'https://search.example.com' })
    await rpc('browser.snapshot')

    const res = await rpc('browser.select', { element: '@e2', value: 'option-1' })
    expect(res.ok).toBe(true)
    expect((res.result as { selected: string }).selected).toBe('@e2')
  })

  // ── Scroll ──

  it('scrolls the viewport', async () => {
    const res = await rpc('browser.scroll', { direction: 'down' })
    expect(res.ok).toBe(true)
    expect((res.result as { scrolled: string }).scrolled).toBe('down')

    const res2 = await rpc('browser.scroll', { direction: 'up', amount: 200 })
    expect(res2.ok).toBe(true)
    expect((res2.result as { scrolled: string }).scrolled).toBe('up')
  })

  // ── Reload ──

  it('reloads the page', async () => {
    const res = await rpc('browser.reload')
    expect(res.ok).toBe(true)
    expect((res.result as { url: string }).url).toBe('https://example.com')
  })

  // ── Screenshot ──

  it('captures a screenshot', async () => {
    const res = await rpc('browser.screenshot', { format: 'png' })
    expect(res.ok).toBe(true)
    const result = res.result as { data: string; format: string }
    expect(result.format).toBe('png')
    expect(result.data.length).toBeGreaterThan(0)
  })

  // ── Eval ──

  it('evaluates JavaScript in the page context', async () => {
    const res = await rpc('browser.eval', { expression: '2 + 2' })
    expect(res.ok).toBe(true)
    expect((res.result as { result: string }).result).toBe('4')
  })

  // ── Tab management ──

  it('lists open tabs', async () => {
    const res = await rpc('browser.tabList')
    expect(res.ok).toBe(true)
    const result = res.result as { tabs: { index: number; url: string; active: boolean }[] }
    expect(result.tabs).toHaveLength(1)
    expect(result.tabs[0]).toMatchObject({
      index: 0,
      url: 'https://example.com',
      active: true
    })
  })

  it('returns error for out-of-range tab switch', async () => {
    const res = await rpc('browser.tabSwitch', { index: 5 })
    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_tab_not_found')
  })

  // ── Full agent workflow simulation ──

  it('simulates a complete agent workflow: navigate → snapshot → interact → re-snapshot', async () => {
    // 1. Navigate to search page
    const gotoRes = await rpc('browser.goto', { url: 'https://search.example.com' })
    expect(gotoRes.ok).toBe(true)

    // 2. Snapshot the page
    const snap1 = await rpc('browser.snapshot')
    expect(snap1.ok).toBe(true)
    const snap1Result = snap1.result as {
      snapshot: string
      refs: { ref: string; role: string; name: string }[]
    }

    // Verify we see the search page structure
    expect(snap1Result.snapshot).toContain('[Main Nav]')
    expect(snap1Result.snapshot).toContain('text input "Search query"')
    expect(snap1Result.snapshot).toContain('button "Search"')

    // 3. Fill the search input
    const searchInput = snap1Result.refs.find((r) => r.name === 'Search query')
    expect(searchInput).toBeDefined()
    const fillRes = await rpc('browser.fill', {
      element: searchInput!.ref,
      value: 'integration testing'
    })
    expect(fillRes.ok).toBe(true)

    // 4. Click the search button
    const searchBtn = snap1Result.refs.find((r) => r.name === 'Search')
    expect(searchBtn).toBeDefined()
    const clickRes = await rpc('browser.click', { element: searchBtn!.ref })
    expect(clickRes.ok).toBe(true)

    // 5. Take a screenshot
    const ssRes = await rpc('browser.screenshot')
    expect(ssRes.ok).toBe(true)

    // 6. Check tab list
    const tabRes = await rpc('browser.tabList')
    expect(tabRes.ok).toBe(true)
    const tabs = (tabRes.result as { tabs: { url: string }[] }).tabs
    expect(tabs[0].url).toBe('https://search.example.com')
  })

  // ── No tab errors ──

  it('returns browser_no_tab when no tabs are registered', async () => {
    // Create a fresh setup with no registered tabs
    const emptyManager = new BrowserManager()
    const emptyBridge = new CdpBridge(emptyManager)

    const userDataPath2 = mkdtempSync(join(tmpdir(), 'browser-e2e-empty-'))
    const runtime2 = new OrcaRuntimeService()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runtime2.setAgentBrowserBridge(emptyBridge as any)

    const server2 = new OrcaRuntimeRpcServer({ runtime: runtime2, userDataPath: userDataPath2 })
    await server2.start()

    const metadata2 = readRuntimeMetadata(userDataPath2)!
    const res = await sendRequest(metadata2.transports[0]!.endpoint, {
      id: 'req_no_tab',
      authToken: metadata2.authToken,
      method: 'browser.snapshot'
    })

    expect(res.ok).toBe(false)
    expect((res.error as { code: string }).code).toBe('browser_no_tab')

    await server2.stop()
  })
})

describe('CdpBridge direct browser commands', () => {
  function createBridgeWithTabs(
    tabs: { browserPageId: string; webContentsId: number; url: string; title: string }[]
  ) {
    const guests = new Map<number, ReturnType<typeof createMockGuest>>()
    for (const tab of tabs) {
      guests.set(tab.webContentsId, createMockGuest(tab.webContentsId, tab.url, tab.title))
    }
    webContentsFromIdMock.mockImplementation((id: number) => guests.get(id)?.guest ?? null)

    const browserManager = new BrowserManager()
    for (const tab of tabs) {
      const guest = guests.get(tab.webContentsId)!.guest
      browserManager.attachGuestPolicies(guest as never)
      browserManager.registerGuest({
        browserPageId: tab.browserPageId,
        webContentsId: tab.webContentsId,
        rendererWebContentsId: RENDERER_WC_ID
      })
    }

    const bridge = new CdpBridge(browserManager)
    if (tabs[0]) {
      bridge.setActiveTab(tabs[0].webContentsId)
    }
    return { bridge, guests }
  }

  const RENDERER_WC_ID = 1

  beforeEach(() => {
    vi.useRealTimers()
    webContentsFromIdMock.mockReset()
  })

  it('reports page metadata, live tab lists, tab switches, and closed-tab cleanup', async () => {
    const { bridge, guests } = createBridgeWithTabs([
      {
        browserPageId: 'page-1',
        webContentsId: 6101,
        url: 'https://example.com',
        title: 'Example Domain'
      },
      {
        browserPageId: 'page-2',
        webContentsId: 6102,
        url: 'https://search.example.com',
        title: 'Search'
      }
    ])

    expect(bridge.getActiveWebContentsId()).toBe(6101)
    expect(bridge.getActivePageId()).toBe('page-1')
    expect(bridge.getPageInfo(undefined, 'page-2')).toMatchObject({
      browserPageId: 'page-2',
      url: 'https://search.example.com',
      title: 'Search'
    })

    expect(bridge.tabList().tabs.map((tab) => [tab.browserPageId, tab.active])).toEqual([
      ['page-1', true],
      ['page-2', false]
    ])

    await expect(bridge.tabSwitch(1)).resolves.toEqual({ switched: 1, browserPageId: 'page-2' })
    expect(bridge.getActiveWebContentsId()).toBe(6102)
    bridge.onTabClosed(6102)
    expect(bridge.getActiveWebContentsId()).toBeNull()

    guests.get(6101)!.guest.isDestroyed.mockReturnValue(true)
    expect(bridge.getPageInfo(undefined, 'page-1')).toBeNull()
  })

  it('runs pointer, upload, focus, clear, checkbox, select-all, and keypress commands', async () => {
    const { bridge, guests } = createBridgeWithTabs([
      {
        browserPageId: 'page-1',
        webContentsId: 6201,
        url: 'https://search.example.com',
        title: 'Search'
      }
    ])
    const guest = guests.get(6201)!

    await bridge.snapshot()

    await expect(bridge.hover('@e1')).resolves.toEqual({ hovered: '@e1' })
    await expect(bridge.drag('@e1', '@e1')).resolves.toEqual({
      dragged: { from: '@e1', to: '@e1' }
    })
    await expect(bridge.uploadFile('@e1', ['/tmp/a.txt', '/tmp/b.txt'])).resolves.toEqual({
      uploaded: 2
    })
    await expect(bridge.focus('@e1')).resolves.toEqual({ focused: '@e1' })
    await expect(bridge.clear('@e1')).resolves.toEqual({ cleared: '@e1' })
    await expect(bridge.check('@e1', true)).resolves.toEqual({ checked: true })
    await expect(bridge.selectAll('@e1')).resolves.toEqual({ selected: '@e1' })
    await expect(bridge.keypress('Enter')).resolves.toEqual({ pressed: 'Enter' })
    await expect(bridge.keypress('7')).resolves.toEqual({ pressed: '7' })
    await expect(bridge.keypress('x')).resolves.toEqual({ pressed: 'x' })
    await expect(bridge.keypress('?')).resolves.toEqual({ pressed: '?' })

    const commandNames = guest.sendCommandMock.mock.calls.map((call) => call[0])
    expect(commandNames).toContain('DOM.setFileInputFiles')
    expect(
      commandNames.filter((name) => name === 'Input.dispatchMouseEvent').length
    ).toBeGreaterThan(10)
    expect(commandNames).toContain('Input.dispatchKeyEvent')
  })

  it('covers document, cookie, viewport, geolocation, and navigation commands', async () => {
    const { bridge, guests } = createBridgeWithTabs([
      {
        browserPageId: 'page-1',
        webContentsId: 6301,
        url: 'https://example.com',
        title: 'Example Domain'
      }
    ])
    const guest = guests.get(6301)!

    await expect(bridge.pdf()).resolves.toEqual({ data: 'JVBERi0xLjQKJQ==' })
    await expect(bridge.fullPageScreenshot('jpeg')).resolves.toMatchObject({ format: 'jpeg' })
    await expect(bridge.cookieGet('https://example.com')).resolves.toEqual({
      cookies: [
        expect.objectContaining({
          name: 'sid',
          value: 'abc',
          domain: 'example.com'
        })
      ]
    })
    await expect(bridge.cookieSet({ name: 'theme', value: 'dark' })).resolves.toEqual({
      success: true
    })
    await expect(bridge.cookieDelete('theme')).resolves.toEqual({ deleted: true })
    await expect(bridge.setViewport(390, 844, 3, true)).resolves.toEqual({
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      mobile: true
    })
    await expect(bridge.setGeolocation(37.7749, -122.4194, 12)).resolves.toEqual({
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 12
    })

    await bridge.goto('https://search.example.com')
    await expect(bridge.back()).resolves.toMatchObject({
      url: 'https://example.com',
      title: 'Example Domain'
    })

    const commandNames = guest.sendCommandMock.mock.calls.map((call) => call[0])
    expect(commandNames).toEqual(expect.arrayContaining(['Page.printToPDF', 'Network.setCookie']))
  })

  it('buffers interception, console, and network capture state per tab', async () => {
    const { bridge, guests } = createBridgeWithTabs([
      {
        browserPageId: 'page-1',
        webContentsId: 6401,
        url: 'https://example.com',
        title: 'Example Domain'
      }
    ])
    const guest = guests.get(6401)!

    await expect(bridge.interceptEnable(['*.json'])).resolves.toEqual({
      enabled: true,
      patterns: ['*.json']
    })
    guest.emitDebuggerMessage('Fetch.requestPaused', {
      requestId: 'fetch-1',
      request: { url: 'https://example.com/data.json', method: 'GET', headers: { accept: '*' } },
      resourceType: 'XHR'
    })
    expect(bridge.interceptList().requests).toEqual([
      expect.objectContaining({
        id: 'fetch-1',
        url: 'https://example.com/data.json',
        resourceType: 'XHR'
      })
    ])
    await expect(bridge.interceptDisable()).resolves.toEqual({ disabled: true })
    expect(bridge.interceptList().requests).toEqual([])

    await expect(bridge.captureStart()).resolves.toEqual({ capturing: true })
    guest.emitDebuggerMessage('Runtime.consoleAPICalled', {
      type: 'warning',
      args: [{ value: 'one' }, { description: 'two' }],
      timestamp: 123,
      stackTrace: { callFrames: [{ url: 'https://example.com/app.js', lineNumber: 9 }] }
    })
    guest.emitDebuggerMessage('Network.responseReceived', {
      requestId: 'req-1',
      timestamp: 456,
      response: {
        url: 'https://example.com/api',
        status: 201,
        mimeType: 'application/json'
      }
    })
    guest.emitDebuggerMessage('Network.loadingFinished', {
      requestId: 'req-1',
      encodedDataLength: 2048
    })

    expect(bridge.consoleLog(1)).toEqual({
      entries: [
        {
          level: 'warning',
          text: 'one two',
          timestamp: 123,
          url: 'https://example.com/app.js',
          line: 9
        }
      ],
      truncated: false
    })
    expect(bridge.networkLog(1)).toEqual({
      entries: [
        expect.objectContaining({
          url: 'https://example.com/api',
          status: 201,
          mimeType: 'application/json',
          size: 2048,
          timestamp: 456
        })
      ],
      truncated: false
    })
    await expect(bridge.captureStop()).resolves.toEqual({ stopped: true })
  })

  it('surfaces direct command errors for eval, history, and ambiguous active tabs', async () => {
    const { bridge } = createBridgeWithTabs([
      {
        browserPageId: 'page-1',
        webContentsId: 6501,
        url: 'https://example.com',
        title: 'Example Domain'
      }
    ])

    await expect(bridge.evaluate('throw new Error("boom")')).rejects.toMatchObject({
      code: 'browser_eval_error'
    })
    await expect(bridge.back()).rejects.toMatchObject({
      code: 'browser_navigation_failed'
    })

    const { bridge: ambiguousBridge } = createBridgeWithTabs([
      {
        browserPageId: 'page-1',
        webContentsId: 6502,
        url: 'https://example.com',
        title: 'Example Domain'
      },
      {
        browserPageId: 'page-2',
        webContentsId: 6503,
        url: 'https://search.example.com',
        title: 'Search'
      }
    ])
    ambiguousBridge.onTabClosed(6502)

    await expect(ambiguousBridge.snapshot()).rejects.toMatchObject({
      code: 'browser_no_tab'
    })
  })
})
