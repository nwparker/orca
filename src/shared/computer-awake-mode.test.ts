import { describe, expect, it } from 'vitest'
import { computerAwakeSettingsForMode, normalizeComputerAwakeMode } from './computer-awake-mode'

describe('computer awake mode', () => {
  it('maps the legacy enabled setting to Auto', () => {
    expect(normalizeComputerAwakeMode(undefined, true)).toBe('auto')
    expect(normalizeComputerAwakeMode(undefined, false)).toBe('off')
  })

  it('preserves valid explicit modes', () => {
    expect(normalizeComputerAwakeMode('on', false)).toBe('on')
    expect(normalizeComputerAwakeMode('off', true)).toBe('off')
    expect(normalizeComputerAwakeMode('auto', false)).toBe('auto')
  })

  it('writes a safe legacy approximation', () => {
    expect(computerAwakeSettingsForMode('on')).toEqual({
      computerAwakeMode: 'on',
      keepComputerAwakeWhileAgentsRun: true
    })
    expect(computerAwakeSettingsForMode('off')).toEqual({
      computerAwakeMode: 'off',
      keepComputerAwakeWhileAgentsRun: false
    })
  })
})
