/**
 * Visual regression for hidden terminal TUI resize.
 *
 * Run:
 *   pnpm run test:e2e:headful -- terminal-tui-hidden-resize-regression.spec.ts
 *
 * The fixture behaves like an idle alternate-screen Codex/Claude TUI: it paints
 * once, then repaints only on SIGWINCH. The test hides that terminal behind
 * another tab, grows the Electron window, restores the hidden tab, and verifies
 * both the xterm buffer and a screenshot right-edge pixel sample reflect the
 * new width. Playwright attaches before/after PNGs for PR evidence.
 */

import path from 'path'
import type { ElectronApplication, Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  ensureTerminalVisible,
  getActiveTabId
} from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'

type ResizeProbeSnapshot = {
  tabId: string
  ptyId: string | null
  bufferType: string | null
  cols: number
  rows: number
  frame: number | null
  reason: string | null
  sizeMarker: string | null
  rightEdgeLineLength: number
  lines: string[]
}

const SMALL_WINDOW = { width: 980, height: 620 }
const LARGE_WINDOW = { width: 1560, height: 720 }
const TERMINAL_TAB = '[data-testid="sortable-tab"]'

function fixtureCommand(): string {
  const fixturePath = path
    .join(process.cwd(), 'tests', 'e2e', 'tui-hidden-resize.fixture.mjs')
    .replaceAll(path.sep, '/')
  return `node "${fixturePath.replaceAll('"', '\\"')}"`
}

function tabLocator(page: Page, tabId: string) {
  return page.locator(`${TERMINAL_TAB}[data-tab-id="${tabId}"]`).first()
}

function terminalLocator(page: Page, tabId: string) {
  return page.locator(`[data-terminal-overlay-tab-id="${tabId}"] .xterm`).first()
}

async function resizeOrcaWindow(
  electronApp: ElectronApplication,
  page: Page,
  size: { width: number; height: number }
): Promise<void> {
  await electronApp.evaluate(({ BrowserWindow }, nextSize) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) {
      throw new Error('No Electron BrowserWindow available for resize')
    }
    win.setContentSize(nextSize.width, nextSize.height)
    win.center()
  }, size)

  await expect
    .poll(
      () =>
        page.evaluate(() => ({
          width: window.innerWidth,
          height: window.innerHeight
        })),
      {
        timeout: 5_000,
        message: `Electron window did not resize to ${size.width}x${size.height}`
      }
    )
    .toMatchObject(size)
}

async function createTerminalTab(page: Page): Promise<string> {
  const tabId = await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('No active worktree for creating terminal tab')
    }
    const tab = state.createTab(worktreeId)
    state.setActiveTab(tab.id)
    state.setActiveTabType('terminal')
    return tab.id
  })
  await activateTerminalTab(page, tabId)
  return tabId
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((targetTabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is unavailable')
    }
    const state = store.getState()
    state.setActiveTab(targetTabId)
    state.setActiveTabType('terminal')
  }, tabId)
  await expect
    .poll(() => getActiveTabId(page), {
      timeout: 5_000,
      message: `Terminal tab ${tabId} did not become active`
    })
    .toBe(tabId)
  await expect(tabLocator(page, tabId)).toHaveAttribute('data-active', 'true')
}

async function readActiveResizeSnapshot(page: Page): Promise<ResizeProbeSnapshot | null> {
  const tabId = await getActiveTabId(page)
  if (!tabId) {
    return null
  }

  return page.evaluate((activeTabId) => {
    const manager = window.__paneManagers?.get(activeTabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    const terminal = pane?.terminal
    if (!pane || !terminal) {
      return null
    }

    const buffer = terminal.buffer.active
    const lines: string[] = []
    const rowCount = Math.min(terminal.rows, 80)
    for (let row = 0; row < rowCount; row += 1) {
      lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '')
    }

    const joined = lines.join('\n')
    const frameMatch = joined.match(/TUI_RESIZE_FRAME:(\d+)/)
    const reasonMatch = joined.match(/TUI_RESIZE_REASON:([^\s]+)/)
    const sizeMatch = joined.match(/TUI_RESIZE_SIZE:(\d+x\d+)/)
    const rightEdgeLine = lines.find((line) => line.includes('TUI_RESIZE_RIGHT_EDGE:OK')) ?? ''

    return {
      tabId: activeTabId,
      ptyId: pane.container.dataset.ptyId ?? null,
      bufferType: (buffer as { type?: string }).type ?? null,
      cols: terminal.cols,
      rows: terminal.rows,
      frame: frameMatch ? Number(frameMatch[1]) : null,
      reason: reasonMatch?.[1] ?? null,
      sizeMarker: sizeMatch?.[1] ?? null,
      rightEdgeLineLength: rightEdgeLine.length,
      lines
    }
  }, tabId)
}

async function waitForResizeProbe(
  page: Page,
  predicate: (snapshot: ResizeProbeSnapshot) => boolean,
  message: string
): Promise<ResizeProbeSnapshot> {
  let latest: ResizeProbeSnapshot | null = null
  try {
    await expect
      .poll(
        async () => {
          latest = await readActiveResizeSnapshot(page)
          return Boolean(latest && predicate(latest))
        },
        { timeout: 15_000, message }
      )
      .toBe(true)
  } catch (error) {
    const detail = latest ? JSON.stringify(latest, null, 2) : 'null'
    throw new Error(`${message}; latest snapshot: ${detail}`, { cause: error })
  }

  if (!latest) {
    throw new Error(`${message}: no terminal snapshot was captured`)
  }
  return latest
}

async function screenshotTerminal(
  page: Page,
  tabId: string,
  name: string,
  testInfo: TestInfo
): Promise<Buffer> {
  const terminal = terminalLocator(page, tabId)
  await expect(terminal).toBeVisible({ timeout: 5_000 })
  const screenshot = await terminal.screenshot({ animations: 'disabled' })
  await testInfo.attach(name, { body: screenshot, contentType: 'image/png' })
  return screenshot
}

async function countRightEdgeGreenPixels(page: Page, screenshot: Buffer): Promise<number> {
  return page.evaluate(
    async (dataUrl) => {
      const image = new Image()
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve()
        image.onerror = () => reject(new Error('Failed to decode terminal screenshot'))
        image.src = dataUrl
      })

      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      if (!context) {
        throw new Error('Could not create canvas context for screenshot sampling')
      }
      context.drawImage(image, 0, 0)
      const sampleX = Math.floor(canvas.width * 0.88)
      const sampleWidth = Math.max(1, canvas.width - sampleX)
      const sampleHeight = Math.max(1, Math.min(64, Math.floor(canvas.height * 0.18)))
      const data = context.getImageData(sampleX, 0, sampleWidth, sampleHeight).data
      let greenPixels = 0
      for (let offset = 0; offset < data.length; offset += 4) {
        const red = data[offset] ?? 0
        const green = data[offset + 1] ?? 0
        const blue = data[offset + 2] ?? 0
        if (green > 180 && red < 90 && blue < 90) {
          greenPixels += 1
        }
      }
      return greenPixels
    },
    `data:image/png;base64,${screenshot.toString('base64')}`
  )
}

test.describe('Terminal hidden TUI resize visual regression @headful', () => {
  test('hidden alternate-screen TUI repaints to the grown terminal width', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    test.setTimeout(120_000)
    await resizeOrcaWindow(electronApp, orcaPage, SMALL_WINDOW)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const probeTabId = await getActiveTabId(orcaPage)
    if (!probeTabId) {
      throw new Error('Expected a terminal tab for the resize probe')
    }
    const probePtyId = await waitForActivePanePtyId(orcaPage)

    await execInTerminal(orcaPage, probePtyId, fixtureCommand())
    const initial = await waitForResizeProbe(
      orcaPage,
      (snapshot) =>
        snapshot.tabId === probeTabId &&
        snapshot.ptyId === probePtyId &&
        snapshot.frame !== null &&
        snapshot.reason !== null &&
        snapshot.sizeMarker !== null &&
        snapshot.lines.join('\n').includes('TUI_RESIZE_STATUS:clean'),
      'Resize probe did not paint its initial alternate-screen frame'
    )
    const beforeScreenshot = await screenshotTerminal(
      orcaPage,
      probeTabId,
      'tui-hidden-resize-before.png',
      testInfo
    )
    expect(await countRightEdgeGreenPixels(orcaPage, beforeScreenshot)).toBeGreaterThan(50)

    const coveringTabId = await createTerminalTab(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await expect(tabLocator(orcaPage, coveringTabId)).toHaveAttribute('data-active', 'true')

    await resizeOrcaWindow(electronApp, orcaPage, LARGE_WINDOW)
    await activateTerminalTab(orcaPage, probeTabId)
    await expect(terminalLocator(orcaPage, probeTabId)).toBeVisible({ timeout: 5_000 })
    await waitForResizeProbe(
      orcaPage,
      (snapshot) => snapshot.cols > initial.cols,
      'Resize probe xterm did not grow after restore'
    )

    const restored = await waitForResizeProbe(
      orcaPage,
      (snapshot) =>
        snapshot.tabId === probeTabId &&
        snapshot.ptyId === probePtyId &&
        snapshot.reason === 'sigwinch' &&
        snapshot.cols > initial.cols &&
        snapshot.sizeMarker === `${snapshot.cols}x${snapshot.rows}` &&
        snapshot.rightEdgeLineLength >= snapshot.cols - 1,
      'Hidden resize probe did not repaint to the restored terminal width'
    )
    expect(restored.lines.join('\n').match(/TUI_RESIZE_FRAME:/g)).toHaveLength(1)

    const afterScreenshot = await screenshotTerminal(
      orcaPage,
      probeTabId,
      'tui-hidden-resize-after.png',
      testInfo
    )
    expect(await countRightEdgeGreenPixels(orcaPage, afterScreenshot)).toBeGreaterThan(50)
  })
})
