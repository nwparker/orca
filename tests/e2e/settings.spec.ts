import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'

const SETTINGS_SEARCH_PLACEHOLDER = 'Search settings'

async function openSettings(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    if (!store.getState().settings) {
      await store.getState().fetchSettings()
    }
    store.getState().openSettingsPage()
  })
  await expect(page.getByPlaceholder(SETTINGS_SEARCH_PLACEHOLDER)).toBeVisible()
}

test.describe('Settings page', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('filters settings sections and reports an empty result', async ({ orcaPage }) => {
    await openSettings(orcaPage)

    const search = orcaPage.getByPlaceholder(SETTINGS_SEARCH_PLACEHOLDER)
    await expect(orcaPage.getByRole('button', { name: /^General$/ })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: /^Terminal$/ })).toBeVisible()

    await search.fill('telemetry')
    await expect(orcaPage.getByRole('button', { name: /Privacy & Telemetry/i })).toBeVisible()
    await expect(orcaPage.getByRole('heading', { name: /Privacy & Telemetry/i })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: /^Terminal$/ })).toHaveCount(0)

    await search.fill('definitely-no-settings-match')
    await expect(orcaPage.getByText(/No settings found/i)).toBeVisible()

    await search.fill('')
    await expect(orcaPage.getByRole('button', { name: /^General$/ })).toBeVisible()
    await expect(orcaPage.getByRole('button', { name: /^Terminal$/ })).toBeVisible()
  })

  test('Cmd/Ctrl+F focuses search and Escape only closes outside editable fields', async ({
    orcaPage
  }) => {
    await openSettings(orcaPage)

    const search = orcaPage.getByPlaceholder(SETTINGS_SEARCH_PLACEHOLDER)
    await orcaPage.evaluate(() => document.body.focus())
    await pressShortcut(orcaPage, 'f')

    await expect(search).toBeFocused()
    await search.fill('privacy')
    await orcaPage.keyboard.press('Escape')

    // Why: Escape in an input should cancel the field edit, not discard the
    // whole settings page. This mirrors the app-level editable-target guard.
    await expect(search).toBeVisible()

    await orcaPage.evaluate(() => {
      const active = document.activeElement
      if (active instanceof HTMLElement) {
        active.blur()
      }
    })
    await orcaPage.keyboard.press('Escape')

    await expect(search).toBeHidden()
    await expect
      .poll(
        () =>
          orcaPage.evaluate(() => {
            return window.__store?.getState().activeView ?? null
          }),
        { timeout: 3_000 }
      )
      .toBe('terminal')
  })

  test('sidebar navigation scrolls to the selected section', async ({ orcaPage }) => {
    await openSettings(orcaPage)

    await orcaPage.getByRole('button', { name: /^Terminal$/ }).click()
    const terminalSection = orcaPage.locator('section#terminal')
    await expect(terminalSection.getByRole('heading', { name: /^Terminal$/ })).toBeVisible()
    await expect(terminalSection).toBeInViewport({ ratio: 0.1 })

    await orcaPage.getByRole('button', { name: /^Browser$/ }).click()
    const browserSection = orcaPage.locator('section#browser')
    await expect(browserSection.getByRole('heading', { name: /^Browser$/ })).toBeVisible()
    await expect(browserSection).toBeInViewport({ ratio: 0.1 })
  })
})
