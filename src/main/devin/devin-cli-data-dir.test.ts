import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDevinCliDataDir } from './devin-cli-data-dir'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('Devin CLI data root', () => {
  it.each(['win32', 'linux', 'darwin'])('honors the root override on %s', (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    vi.stubEnv('DEVIN_HOME', join(homedir(), 'custom-devin'))
    expect(resolveDevinCliDataDir()).toBe(join(homedir(), 'custom-devin', 'cli'))
  })

  it.each(['win32', 'linux', 'darwin'])('uses the platform data directory on %s', (platform) => {
    vi.stubGlobal('process', { ...process, platform })
    vi.stubEnv('DEVIN_HOME', '')
    vi.stubEnv('APPDATA', join(homedir(), 'appdata'))
    vi.stubEnv('XDG_DATA_HOME', join(homedir(), 'xdg'))
    expect(resolveDevinCliDataDir()).toBe(
      join(homedir(), platform === 'win32' ? 'appdata' : 'xdg', 'devin', 'cli')
    )
  })

  it('ignores relative environment paths', () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' })
    vi.stubEnv('DEVIN_HOME', 'relative')
    vi.stubEnv('XDG_DATA_HOME', 'relative')
    expect(resolveDevinCliDataDir()).toBe(join(homedir(), '.local', 'share', 'devin', 'cli'))
  })
})
