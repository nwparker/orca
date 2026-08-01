import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveTabId,
  getActiveWorktreeId,
  waitForSessionReady
} from './helpers/store'
import { getTerminalContentForPtyId, waitForPtyShellEcho } from './terminal-pty-readiness'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { compareTerminalScreenshots } from './terminal-screenshot-diff'

const OPENCODE_ROOT = process.env.ORCA_E2E_OPENCODE_ROOT
const EVIDENCE_DIR = path.join(process.cwd(), '.tmp', 'issue-11757-opencode-tab-reveal-fix')
const STREAM_TRIGGER_PATH = path.join(EVIDENCE_DIR, 'stream.trigger')
const FRAME_MARKER = 'OPENCODE_FULLSCREEN_TUI_REPRO'

type PaneClip = { x: number; y: number; width: number; height: number }

type TerminalProbe = {
  frameText: string
  synchronizedOutput: boolean
  paused: boolean
  cols: number
  rows: number
}

type AtlasResetCounts = Record<string, number>

function quoteTerminalArg(value: string): string {
  if (process.platform === 'win32') {
    return `'${value.replaceAll("'", "''")}'`
  }
  return `'${value.replaceAll("'", "'\\''")}'`
}

function opencodeFullScreenHarnessCommand(root: string, triggerPath: string): string {
  const bun = process.env.ORCA_E2E_BUN_EXECUTABLE ?? 'bun'
  const packageDirectory = path.join(root, 'packages', 'opencode')
  const harness = String.raw`
;(async () => {
  const { existsSync, unlinkSync } = await import('node:fs')
  const { BoxRenderable, TextRenderable, createCliRenderer } = await import('@opentui/core')
  const triggerPath = ${JSON.stringify(triggerPath)}

  const renderer = await createCliRenderer({
    externalOutputMode: 'passthrough',
    targetFps: 60,
    gatherStats: false,
    exitOnCtrlC: false,
    useKittyKeyboard: {},
    autoFocus: false,
    openConsoleOnError: false,
    useMouse: false
  })
  const rootRenderable = renderer.root
  const ctx = rootRenderable.ctx
  const panel = new BoxRenderable(ctx, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    paddingLeft: 2,
    paddingTop: 1,
    gap: 1
  })
  rootRenderable.add(panel)

  const header = new BoxRenderable(ctx, { flexDirection: 'row', gap: 1, height: 1 })
  panel.add(header)
  header.add(new TextRenderable(ctx, { content: '◆', fg: '#ff8a00' }))
  header.add(new TextRenderable(ctx, { content: '${FRAME_MARKER}', fg: '#ff8a00' }))

  const frameText = new TextRenderable(ctx, {
    content: '${FRAME_MARKER} frame 00000 ready',
    fg: '#e7edf7'
  })
  panel.add(frameText)
  panel.add(new TextRenderable(ctx, {
    content: '╭──────────────────────────────────────────────────────────────────────────────╮',
    fg: '#6aa9ff'
  }))
  const rows = []
  for (let index = 0; index < 26; index += 1) {
    const row = new TextRenderable(ctx, {
      content: '│ ' + String(index + 1).padStart(2, '0') + '  OpenCode streaming tool output ' + '#'.repeat(38) + ' │',
      fg: index % 2 === 0 ? '#e7edf7' : '#a9b7c6'
    })
    rows.push(row)
    panel.add(row)
  }
  panel.add(new TextRenderable(ctx, {
    content: '╰──────────────────────────────────────────────────────────────────────────────╯',
    fg: '#6aa9ff'
  }))

  let frame = 0
  let timer = null
  let triggerTimer = null
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    if (timer) clearInterval(timer)
    if (triggerTimer) clearInterval(triggerTimer)
    renderer.destroy()
    process.exit(0)
  }
  const renderCanonicalFrame = () => {
    frame = 0
    frameText.content = '${FRAME_MARKER} frame 00000 ready'
    for (const [index, row] of rows.entries()) {
      row.content = '│ ' + String(index + 1).padStart(2, '0') +
        '  OpenCode streaming tool output ' + '#'.repeat(38) + ' │'
    }
    renderer.requestRender()
  }
  const startStreaming = () => {
    if (timer) clearInterval(timer)
    frame = 0
    timer = setInterval(() => {
      frame += 1
      frameText.content = '${FRAME_MARKER} frame ' + String(frame).padStart(5, '0') +
        (frame % 2 === 0 ? ' thinking' : ' streaming')
      for (const [index, row] of rows.entries()) {
        const phase = (frame + index) % 32
        row.content = '│ ' + String(index + 1).padStart(2, '0') +
          '  OpenCode streaming tool output ' + '#'.repeat(phase + 6).padEnd(38, ' ') + ' │'
      }
      renderer.requestRender()
      if (frame >= 30) {
        clearInterval(timer)
        timer = null
        renderCanonicalFrame()
      }
    }, 28)
  }
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
  process.stdin.resume()
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (data) => {
    const input = Buffer.from(data)
    if (input.includes(3)) stop()
  })
  triggerTimer = setInterval(() => {
    if (!existsSync(triggerPath)) return
    unlinkSync(triggerPath)
    startStreaming()
  }, 20)
  renderCanonicalFrame()
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
`
  const encoded = Buffer.from(harness, 'utf8').toString('base64')
  const expression = `eval(Buffer.from('${encoded}', 'base64').toString())`
  return [
    quoteTerminalArg(bun),
    '--cwd',
    quoteTerminalArg(packageDirectory),
    '-e',
    quoteTerminalArg(expression)
  ].join(' ')
}

async function createSiblingTerminalTab(page: Page, worktreeId: string): Promise<string> {
  return page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    return store.getState().createTab(worktreeId, undefined, undefined, { activate: false }).id
  }, worktreeId)
}

async function activateTerminalTab(page: Page, tabId: string): Promise<void> {
  await page.evaluate((tabId) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setActiveTabType('terminal')
    store.getState().setActiveTab(tabId)
  }, tabId)
  await expect.poll(() => getActiveTabId(page), { timeout: 5_000 }).toBe(tabId)
  await waitForActiveTerminalManager(page, 15_000)
}

async function setWebglEnabled(page: Page, tabId: string): Promise<boolean> {
  await page.evaluate((tabId) => {
    const state = window.__store?.getState()
    if (!state?.settings) {
      throw new Error('Store unavailable')
    }
    window.__store?.setState({
      settings: { ...state.settings, terminalGpuAcceleration: 'on' }
    })
    window.__paneManagers?.get(tabId)?.setTerminalGpuAcceleration?.('on')
  }, tabId)
  return page
    .waitForFunction(
      (tabId) =>
        (window.__paneManagers?.get(tabId)?.getRenderingDiagnostics?.() ?? []).some(
          (diagnostic) => diagnostic.hasWebgl
        ),
      tabId,
      { timeout: 20_000 }
    )
    .then(() => true)
    .catch(() => false)
}

async function readPaneClip(page: Page, tabId: string): Promise<PaneClip> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    const rect = pane?.container.getBoundingClientRect()
    if (!rect || rect.width < 10 || rect.height < 10) {
      throw new Error(`No visible pane clip for tab ${tabId}`)
    }
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }, tabId)
}

async function captureStablePane(page: Page, tabId: string): Promise<Buffer> {
  let previous = await page.screenshot({ clip: await readPaneClip(page, tabId) })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.waitForTimeout(80)
    const current = await page.screenshot({ clip: await readPaneClip(page, tabId) })
    if (current.equals(previous)) {
      return current
    }
    previous = current
  }
  throw new Error('OpenCode pane did not reach a stable frame')
}

async function installAtlasResetProbe(page: Page, tabIds: string[]): Promise<void> {
  await page.evaluate((tabIds) => {
    const scope = window as Window & {
      __opencodeRevealResetProbe?: { counts: AtlasResetCounts; restore: () => void }
    }
    const counts: AtlasResetCounts = {}
    const restores: (() => void)[] = []
    for (const tabId of tabIds) {
      const manager = window.__paneManagers?.get(tabId)
      if (!manager) {
        throw new Error(`No pane manager for tab ${tabId}`)
      }
      const original = manager.resetWebglTextureAtlases
      counts[tabId] = 0
      manager.resetWebglTextureAtlases = function () {
        counts[tabId] += 1
        return original.call(manager)
      }
      restores.push(() => {
        manager.resetWebglTextureAtlases = original
      })
    }
    scope.__opencodeRevealResetProbe = {
      counts,
      restore: () => restores.forEach((restore) => restore())
    }
  }, tabIds)
}

async function readAtlasResetCounts(page: Page): Promise<AtlasResetCounts> {
  return page.evaluate(() => {
    const probe = (
      window as Window & {
        __opencodeRevealResetProbe?: { counts: AtlasResetCounts }
      }
    ).__opencodeRevealResetProbe
    if (!probe) {
      throw new Error('Atlas reset probe unavailable')
    }
    return { ...probe.counts }
  })
}

async function uninstallAtlasResetProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as Window & {
      __opencodeRevealResetProbe?: { restore: () => void }
    }
    scope.__opencodeRevealResetProbe?.restore()
    delete scope.__opencodeRevealResetProbe
  })
}

async function readTerminalProbe(page: Page, tabId: string): Promise<TerminalProbe> {
  return page.evaluate((tabId) => {
    const manager = window.__paneManagers?.get(tabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    if (!pane) {
      throw new Error(`No pane for tab ${tabId}`)
    }
    const terminal = pane.terminal
    const buffer = terminal.buffer.active
    const frameText = Array.from({ length: terminal.rows }, (_, row) => {
      return buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? ''
    }).join('\n')
    const core = terminal._core as {
      coreService?: { decPrivateModes?: { synchronizedOutput?: boolean } }
      _renderService?: { _isPaused?: boolean }
    }
    return {
      frameText,
      synchronizedOutput: core.coreService?.decPrivateModes?.synchronizedOutput === true,
      paused: core._renderService?._isPaused === true,
      cols: terminal.cols,
      rows: terminal.rows
    }
  }, tabId)
}

async function toggleSidebarForRepaint(page: Page): Promise<void> {
  const wasOpen = await page.evaluate(() => window.__store?.getState().rightSidebarOpen ?? false)
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setRightSidebarOpen(!store.getState().rightSidebarOpen)
  })
  await page.waitForTimeout(250)
  await page.evaluate((wasOpen) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    store.getState().setRightSidebarOpen(wasOpen)
  }, wasOpen)
  await page.waitForTimeout(500)
}

test('keeps a streaming full-screen OpenTUI intact across a hidden tab reveal', async ({
  orcaPage
}, testInfo: TestInfo) => {
  test.setTimeout(150_000)
  test.skip(
    !OPENCODE_ROOT || !existsSync(path.join(OPENCODE_ROOT, 'packages', 'opencode', 'package.json')),
    'Set ORCA_E2E_OPENCODE_ROOT to a checked-out OpenCode source tree to run the full-screen OpenTUI repro'
  )

  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)

  const worktreeId = await getActiveWorktreeId(orcaPage)
  const firstTabId = await getActiveTabId(orcaPage)
  if (!worktreeId || !firstTabId || !OPENCODE_ROOT) {
    throw new Error('No active worktree terminal tab')
  }
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 20_000)
  test.skip(
    !(await setWebglEnabled(orcaPage, firstTabId)),
    'WebGL is required for the full-screen paint-layer repro'
  )

  let before: Buffer | undefined
  let afterReveal: Buffer | undefined
  let afterResize: Buffer | undefined
  let resetProbeInstalled = false
  try {
    mkdirSync(EVIDENCE_DIR, { recursive: true })
    if (existsSync(STREAM_TRIGGER_PATH)) {
      unlinkSync(STREAM_TRIGGER_PATH)
    }
    await sendToTerminal(
      orcaPage,
      ptyId,
      `${opencodeFullScreenHarnessCommand(OPENCODE_ROOT, STREAM_TRIGGER_PATH)}\r`
    )
    await expect
      .poll(() => getTerminalContentForPtyId(orcaPage, ptyId, 40_000), {
        timeout: 45_000,
        message: 'OpenCode source OpenTUI harness did not render its full-screen marker'
      })
      .toContain(FRAME_MARKER)
    await orcaPage.waitForTimeout(500)

    before = await captureStablePane(orcaPage, firstTabId)
    const secondTabId = await createSiblingTerminalTab(orcaPage, worktreeId)
    await activateTerminalTab(orcaPage, secondTabId)
    await orcaPage.waitForTimeout(500)
    await installAtlasResetProbe(orcaPage, [firstTabId, secondTabId])
    resetProbeInstalled = true

    writeFileSync(STREAM_TRIGGER_PATH, 'stream')
    await orcaPage.waitForTimeout(120)
    const triggerConsumed = !existsSync(STREAM_TRIGGER_PATH)
    const hidden = await readTerminalProbe(orcaPage, firstTabId)
    await activateTerminalTab(orcaPage, firstTabId)
    await orcaPage.waitForTimeout(650)
    const resetCounts = await readAtlasResetCounts(orcaPage)
    await orcaPage.waitForTimeout(180)
    const afterRevealProbe = await readTerminalProbe(orcaPage, firstTabId)
    afterReveal = await captureStablePane(orcaPage, firstTabId)

    await toggleSidebarForRepaint(orcaPage)
    const afterResizeProbe = await readTerminalProbe(orcaPage, firstTabId)
    afterResize = await captureStablePane(orcaPage, firstTabId)
    const revealDiff = compareTerminalScreenshots(before, afterReveal)
    const resizeDiff = compareTerminalScreenshots(before, afterResize)

    mkdirSync(EVIDENCE_DIR, { recursive: true })
    writeFileSync(path.join(EVIDENCE_DIR, 'before.png'), before)
    writeFileSync(path.join(EVIDENCE_DIR, 'after-reveal.png'), afterReveal)
    writeFileSync(path.join(EVIDENCE_DIR, 'after-resize.png'), afterResize)
    writeFileSync(
      path.join(EVIDENCE_DIR, 'state.json'),
      `${JSON.stringify(
        {
          triggerConsumed,
          hidden,
          afterRevealProbe,
          afterResizeProbe,
          resetCounts,
          revealDiff,
          resizeDiff
        },
        null,
        2
      )}\n`
    )

    await testInfo.attach('fullscreen-opentui-before.png', {
      body: before,
      contentType: 'image/png'
    })
    await testInfo.attach('fullscreen-opentui-after-reveal.png', {
      body: afterReveal,
      contentType: 'image/png'
    })
    await testInfo.attach('fullscreen-opentui-after-resize.png', {
      body: afterResize,
      contentType: 'image/png'
    })
    await testInfo.attach('fullscreen-opentui-state.json', {
      body: Buffer.from(
        JSON.stringify(
          {
            triggerConsumed,
            hidden,
            afterRevealProbe,
            afterResizeProbe,
            resetCounts,
            revealDiff,
            resizeDiff
          },
          null,
          2
        )
      ),
      contentType: 'application/json'
    })
    console.log(
      `[terminal-repro] fullscreen-opentui=${JSON.stringify({
        triggerConsumed,
        hidden,
        afterRevealProbe,
        afterResizeProbe,
        resetCounts,
        revealDiff,
        resizeDiff
      })}`
    )

    expect(triggerConsumed).toBe(true)
    expect(afterRevealProbe.frameText).toContain(`${FRAME_MARKER} frame 00000 ready`)
    expect(resetCounts[firstTabId]).toBe(1)
    expect(resetCounts[secondTabId]).toBe(1)
    expect(revealDiff.matches).toBe(true)
    expect(resizeDiff.matches).toBe(true)
  } finally {
    if (resetProbeInstalled) {
      await uninstallAtlasResetProbe(orcaPage).catch(() => {})
    }
    if (existsSync(STREAM_TRIGGER_PATH)) {
      unlinkSync(STREAM_TRIGGER_PATH)
    }
    await sendToTerminal(orcaPage, ptyId, '\u0003\u0003').catch(() => {})
  }
})
