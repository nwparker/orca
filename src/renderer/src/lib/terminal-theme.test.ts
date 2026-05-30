import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_THEME_DARK,
  DEFAULT_TERMINAL_THEME_LIGHT,
  getTerminalThemePreview,
  isTerminalBackgroundLight,
  resolveEffectiveTerminalAppearance
} from './terminal-theme'

describe('resolveEffectiveTerminalAppearance', () => {
  it('uses the light terminal theme for system theme on light OS when light variant is enabled', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'system',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#d4d4d8'
      },
      false
    )

    expect(appearance.mode).toBe('light')
    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_LIGHT)
  })

  it('uses the dark terminal theme for system theme on dark OS', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'system',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#d4d4d8'
      },
      true
    )

    expect(appearance.mode).toBe('dark')
    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_DARK)
  })

  it('reuses the dark terminal theme in light mode when separate light theme is disabled', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'light',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: false,
        terminalThemeLight: DEFAULT_TERMINAL_THEME_LIGHT,
        terminalDividerColorLight: '#d4d4d8'
      },
      false
    )

    expect(appearance.mode).toBe('light')
    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_DARK)
  })

  it('falls back to the default light theme when terminalThemeLight is blank', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'light',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: '',
        terminalDividerColorLight: '#d4d4d8'
      },
      false
    )

    expect(appearance.themeName).toBe(DEFAULT_TERMINAL_THEME_LIGHT)
  })

  it('keeps invalid terminalThemeLight names while preview falls back to dark', () => {
    const appearance = resolveEffectiveTerminalAppearance(
      {
        theme: 'light',
        terminalThemeDark: DEFAULT_TERMINAL_THEME_DARK,
        terminalDividerColorDark: '#3f3f46',
        terminalUseSeparateLightTheme: true,
        terminalThemeLight: 'Invalid Theme Name',
        terminalDividerColorLight: '#d4d4d8'
      },
      false
    )

    expect(appearance.themeName).toBe('Invalid Theme Name')
    expect(appearance.theme).toEqual(getTerminalThemePreview(DEFAULT_TERMINAL_THEME_DARK))
  })
})

function hexChannelToLinear(value: string): number {
  const channel = parseInt(value, 16) / 255
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4)
}

function relativeLuminance(hex: string): number {
  const clean = hex.replace('#', '')
  const r = hexChannelToLinear(clean.slice(0, 2))
  const g = hexChannelToLinear(clean.slice(2, 4))
  const b = hexChannelToLinear(clean.slice(4, 6))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(foreground: string, background: string): number {
  const fg = relativeLuminance(foreground)
  const bg = relativeLuminance(background)
  const lighter = Math.max(fg, bg)
  const darker = Math.min(fg, bg)
  return (lighter + 0.05) / (darker + 0.05)
}

describe('default light terminal theme contrast', () => {
  it('keeps ANSI white text readable on its white background', () => {
    const theme = getTerminalThemePreview(DEFAULT_TERMINAL_THEME_LIGHT)

    // Why: agent TUIs commonly use ANSI white/bright-white for dim code and
    // diff metadata; near-white values disappear in Orca light mode.
    expect(contrastRatio(theme!.white!, theme!.background!)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(theme!.brightWhite!, theme!.background!)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('isTerminalBackgroundLight', () => {
  it('classifies common terminal background color formats by luminance', () => {
    expect(isTerminalBackgroundLight('#ffffff')).toBe(true)
    expect(isTerminalBackgroundLight('#18181b')).toBe(false)
    expect(isTerminalBackgroundLight('#fffc')).toBe(true)
    expect(isTerminalBackgroundLight('rgb(245 245 244)')).toBe(true)
    expect(isTerminalBackgroundLight('rgba(24, 24, 27, 0.92)')).toBe(false)
  })

  it('classifies transparent backgrounds after compositing with the app surface', () => {
    expect(
      isTerminalBackgroundLight('#ffffff', { backgroundOpacity: 0.1, appSurface: 'dark' })
    ).toBe(false)
    expect(
      isTerminalBackgroundLight('#ffffff', { backgroundOpacity: 0.6, appSurface: 'dark' })
    ).toBe(true)
    expect(isTerminalBackgroundLight('rgba(255, 255, 255, 0.1)', { appSurface: 'dark' })).toBe(
      false
    )
    expect(isTerminalBackgroundLight('rgb(255 255 255 / 10%)', { appSurface: 'dark' })).toBe(false)
    expect(
      isTerminalBackgroundLight('#000000', { backgroundOpacity: 0.1, appSurface: 'light' })
    ).toBe(true)
  })

  it('defaults unknown colors to dark-surface title styling', () => {
    expect(isTerminalBackgroundLight(undefined)).toBe(false)
    expect(isTerminalBackgroundLight('var(--background)')).toBe(false)
  })
})
