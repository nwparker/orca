import type { Page } from '@stablyai/playwright-test'

type ShortcutOptions = {
  alt?: boolean
  shift?: boolean
}

const modifierKeyByPage = new WeakMap<Page, 'Meta' | 'Control'>()
const isMacByPage = new WeakMap<Page, boolean>()

export async function isMacPage(page: Page): Promise<boolean> {
  const cached = isMacByPage.get(page)
  if (cached !== undefined) {
    return cached
  }

  const isMac = await page.evaluate(() => navigator.userAgent.includes('Mac'))
  isMacByPage.set(page, isMac)
  return isMac
}

export async function getPlatformShortcutModifier(page: Page): Promise<'Meta' | 'Control'> {
  const cached = modifierKeyByPage.get(page)
  if (cached) {
    return cached
  }

  const isMac = await isMacPage(page)
  const modifierKey = isMac ? 'Meta' : 'Control'
  modifierKeyByPage.set(page, modifierKey)
  return modifierKey
}

export async function platformShortcutChord(
  page: Page,
  key: string,
  options: ShortcutOptions = {}
): Promise<string> {
  const parts = [await getPlatformShortcutModifier(page)]
  if (options.alt) {
    parts.push('Alt')
  }
  if (options.shift) {
    parts.push('Shift')
  }
  parts.push(key)
  return parts.join('+')
}

/**
 * Press a Cmd/Ctrl shortcut using the platform-specific modifier key.
 *
 * Why: Orca binds shortcuts as Cmd on macOS and Ctrl on Linux/Windows. Using
 * a helper keeps the E2E suite aligned with the app's runtime shortcut logic
 * instead of hardcoding macOS-only key chords in each spec.
 */
export async function pressShortcut(
  page: Page,
  key: string,
  options: ShortcutOptions = {}
): Promise<void> {
  await page.keyboard.press(await platformShortcutChord(page, key, options))
}
