import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  isClaudeCodeVersionAffectedByWebglGlyphBug,
  resetClaudeCodeWebglGuardCacheForTests,
  shouldSuppressWebglForLocalClaudeCode
} from './claude-code-webgl-guard'

describe('claude-code-webgl-guard', () => {
  beforeEach(() => {
    resetClaudeCodeWebglGuardCacheForTests()
    ;(globalThis as unknown as { window: unknown }).window = {
      api: {
        preflight: {
          getAgentVersion: vi.fn().mockResolvedValue(null)
        }
      }
    }
  })

  afterEach(() => {
    resetClaudeCodeWebglGuardCacheForTests()
    delete (globalThis as unknown as { window?: unknown }).window
  })

  it.each([
    ['2.1.143 (Claude Code)', true],
    ['2.1.144 (Claude Code)', false],
    ['2.0.99 (Claude Code)', true],
    ['3.0.0 (Claude Code)', false],
    [null, false],
    ['Claude Code dev', false]
  ] as const)('classifies %s as affected=%s', (versionOutput, expected) => {
    expect(isClaudeCodeVersionAffectedByWebglGlyphBug(versionOutput)).toBe(expected)
  })

  it('suppresses WebGL for affected local Claude Code versions', async () => {
    vi.mocked(window.api.preflight.getAgentVersion).mockResolvedValue('2.1.143 (Claude Code)')

    await expect(shouldSuppressWebglForLocalClaudeCode()).resolves.toBe(true)
    await expect(shouldSuppressWebglForLocalClaudeCode()).resolves.toBe(true)
    expect(window.api.preflight.getAgentVersion).toHaveBeenCalledTimes(1)
  })

  it('keeps WebGL enabled when the version cannot be checked', async () => {
    vi.mocked(window.api.preflight.getAgentVersion).mockRejectedValue(new Error('not found'))

    await expect(shouldSuppressWebglForLocalClaudeCode()).resolves.toBe(false)
  })
})
