import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  getTerminalContent,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { waitForTerminalPtyDataInjector } from './helpers/terminal-pty-injection'

const STREAMING_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests/e2e/fixtures/streaming-scrollback-fixture.cjs'
)

type RevealFrame = {
  targetPresented: boolean
  thumbTop: number | null
  maxThumbTop: number | null
}

async function closeFeatureTips(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    store?.getState().markFeatureTipsSeen(['orca-cli', 'cmd-j-palette', 'voice-dictation'])
    if (store?.getState().activeModal === 'feature-tips') {
      store.getState().closeModal()
    }
  })
}

async function activeTerminalTabId(page: Page): Promise<string> {
  const tabId = await page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    return state?.activeTabType === 'terminal'
      ? (state.activeTabId ?? null)
      : worktreeId
        ? (state?.activeTabIdByWorktree?.[worktreeId] ?? null)
        : null
  })
  if (!tabId) {
    throw new Error('Active terminal tab unavailable')
  }
  return tabId
}

async function injectQueuedWriteAndRefocus(
  page: Page,
  tabId: string,
  paneKey: string
): Promise<void> {
  await page.evaluate(
    ({ targetTabId, paneKey }) => {
      const pane = window.__paneManagers?.get(targetTabId)?.getPanes?.()[0]
      if (!pane) {
        throw new Error('Hidden terminal pane unavailable')
      }
      const terminal = pane.terminal
      // Why: fail loudly if xterm moves the private buffer path that models this wobble.
      const bufferService = (
        terminal as typeof terminal & {
          _core?: {
            _bufferService?: { buffer?: { ydisp: number }; isUserScrolling: boolean }
          }
        }
      )._core?._bufferService
      const internalBuffer = bufferService?.buffer
      if (!internalBuffer || !bufferService) {
        throw new Error('xterm internal buffer unavailable')
      }
      const originalWrite = terminal.write
      let wobbleApplied = false
      terminal.write = ((data: string, callback?: () => void) => {
        terminal.write = originalWrite
        wobbleApplied = true
        internalBuffer.ydisp = 0
        bufferService.isUserScrolling = true
        if (terminal.buffer.active.viewportY !== 0) {
          throw new Error('xterm viewport wobble was not observable')
        }
        originalWrite.call(terminal, data, callback)
      }) as typeof terminal.write
      const injector = (
        window as Window & {
          __terminalPtyDataInjection?: {
            inject: (paneKey: string, data: string) => boolean
          }
        }
      ).__terminalPtyDataInjection
      const rows = Array.from(
        { length: 400 },
        (_, index) => `REFOCUS_STREAM_ROW_${String(index).padStart(4, '0')}_${'x'.repeat(80)}\n`
      ).join('')
      if (!injector?.inject(paneKey, `${rows}REFOCUS_STREAM_DONE\n`)) {
        throw new Error('PTY data injector unavailable')
      }
      // Why: focus recovery must flush through terminal.write in this synchronous dispatch.
      window.dispatchEvent(new Event('focus'))
      if (!wobbleApplied) {
        throw new Error('refocus did not flush the queued xterm write')
      }
    },
    { targetTabId: tabId, paneKey }
  )
}

async function sampleRevealFrames(page: Page, targetTabId: string): Promise<RevealFrame[]> {
  return page.evaluate(
    (targetTabId) =>
      new Promise<RevealFrame[]>((resolve) => {
        const frames: RevealFrame[] = []
        const startedAt = performance.now()
        const isPresented = (element: Element | null): boolean => {
          if (!(element instanceof HTMLElement)) {
            return false
          }
          for (
            let current: HTMLElement | null = element;
            current;
            current = current.parentElement
          ) {
            const style = getComputedStyle(current)
            if (
              style.display === 'none' ||
              style.visibility === 'hidden' ||
              style.opacity === '0'
            ) {
              return false
            }
          }
          const rect = element.getBoundingClientRect()
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            rect.right > 0 &&
            rect.bottom > 0 &&
            rect.left < window.innerWidth &&
            rect.top < window.innerHeight
          )
        }
        const sample = (): void => {
          const pane = window.__paneManagers?.get(targetTabId)?.getPanes?.()[0]
          const targetXterm = pane?.container.querySelector('.xterm') ?? null
          const scrollbar =
            targetXterm?.querySelector<HTMLElement>('.xterm-scrollbar.xterm-vertical') ?? null
          const thumb = scrollbar?.querySelector<HTMLElement>('.xterm-slider') ?? null
          frames.push({
            targetPresented: isPresented(targetXterm),
            thumbTop: thumb?.offsetTop ?? null,
            maxThumbTop: scrollbar && thumb ? scrollbar.clientHeight - thumb.offsetHeight : null
          })
          if (performance.now() - startedAt >= 700) {
            resolve(frames)
            return
          }
          requestAnimationFrame(sample)
        }
        sample()
      }),
    targetTabId
  )
}

test.describe('terminal streaming refocus viewport', () => {
  test('keeps follow-output at the bottom through a queued-write refocus wobble', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await closeFeatureTips(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const tabId = await activeTerminalTabId(orcaPage)
    const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
    await waitForTerminalPtyDataInjector(orcaPage, paneKey)
    await execInTerminal(orcaPage, ptyId, `node ${JSON.stringify(STREAMING_FIXTURE_PATH)}`)
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 30_000 })
      .toContain('STREAM_PHASE1_DONE')
    await orcaPage.waitForTimeout(400)

    const framesPromise = sampleRevealFrames(orcaPage, tabId)
    await injectQueuedWriteAndRefocus(orcaPage, tabId, paneKey)
    const frames = await framesPromise

    expect(frames.filter((frame) => !frame.targetPresented)).toEqual([])
    expect(
      frames.filter(
        (frame) =>
          frame.thumbTop === null ||
          frame.maxThumbTop === null ||
          Math.abs(frame.maxThumbTop - frame.thumbTop) > 2
      )
    ).toEqual([])
    expect(frames.some((frame) => (frame.maxThumbTop ?? 0) > 1)).toBe(true)
    expect(
      frames.filter((frame) => (frame.maxThumbTop ?? 0) > 1 && (frame.thumbTop ?? 0) <= 1)
    ).toEqual([])
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 15_000 })
      .toContain('REFOCUS_STREAM_DONE')
    const visibleScrollbar = orcaPage.locator('.xterm-scrollbar.xterm-vertical:visible').first()
    await expect(visibleScrollbar).toBeVisible()
    expect(
      await visibleScrollbar.evaluate((scrollbar) => {
        const thumb = scrollbar.querySelector<HTMLElement>('.xterm-slider')
        return Boolean(
          thumb && Math.abs(scrollbar.clientHeight - thumb.offsetHeight - thumb.offsetTop) <= 2
        )
      })
    ).toBe(true)
  })
})
