import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { CodexManagedAccount, GlobalSettings } from '../../shared/types'
import { waitForManagedCodexAuthReady } from './managed-codex-auth-readiness'

const roots: string[] = []
const testIdToken = 'e30.eyJlbWFpbCI6InVzZXJAZXhhbXBsZS5jb20ifQ.sig'
const testChatGptAuth = {
  tokens: {
    access_token: 'access',
    id_token: testIdToken,
    refresh_token: 'refresh',
    account_id: 'account'
  },
  last_refresh: '2026-07-31T00:00:00Z'
}

afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('waitForManagedCodexAuthReady', () => {
  it('accepts a readable managed ChatGPT credential', async () => {
    const fixture = createFixture()
    writeAuth(fixture.home, testChatGptAuth)

    await waitForManagedCodexAuthReady(fixture.args)
  })

  it('waits for a missing managed credential to be restored', async () => {
    vi.useFakeTimers()
    const fixture = createFixture()
    const readiness = waitForManagedCodexAuthReady(fixture.args)

    await vi.advanceTimersByTimeAsync(50)
    writeAuth(fixture.home, { OPENAI_API_KEY: 'sk-test' })
    await vi.runAllTimersAsync()

    await expect(readiness).resolves.toBeUndefined()
  })

  it('waits for a partial managed ChatGPT credential to become complete', async () => {
    vi.useFakeTimers()
    const fixture = createFixture()
    writeAuth(fixture.home, {
      tokens: { access_token: 'access', id_token: testIdToken }
    })
    let resolved = false
    const readiness = waitForManagedCodexAuthReady(fixture.args)?.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(resolved).toBe(false)
    writeAuth(fixture.home, testChatGptAuth)
    await vi.advanceTimersByTimeAsync(25)

    await expect(readiness).resolves.toBeUndefined()
  })

  it('waits for an empty managed ChatGPT refresh token to be restored', async () => {
    vi.useFakeTimers()
    const fixture = createFixture()
    writeAuth(fixture.home, {
      ...testChatGptAuth,
      tokens: { ...testChatGptAuth.tokens, refresh_token: '' }
    })
    let resolved = false
    const readiness = waitForManagedCodexAuthReady(fixture.args)?.then(() => {
      resolved = true
    })

    await vi.advanceTimersByTimeAsync(50)
    expect(resolved).toBe(false)
    writeAuth(fixture.home, testChatGptAuth)
    await vi.advanceTimersByTimeAsync(25)

    await expect(readiness).resolves.toBeUndefined()
  })

  it('rejects an unreadable managed credential without switching accounts', async () => {
    vi.useFakeTimers()
    const fixture = createFixture()
    writeFileSync(join(fixture.home, 'auth.json'), '{', 'utf8')

    const readiness = waitForManagedCodexAuthReady(fixture.args)
    const rejection = expect(readiness).rejects.toThrow(
      'The selected Codex account credentials are temporarily unavailable'
    )
    await vi.advanceTimersByTimeAsync(2_000)
    await rejection
  })

  it('does not gate system, WSL, or unmanaged custom homes', async () => {
    const fixture = createFixture()
    await waitForManagedCodexAuthReady({
      ...fixture.args,
      codexHomePath: join(fixture.root, 'custom-home')
    })
    await waitForManagedCodexAuthReady({
      ...fixture.args,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
    await waitForManagedCodexAuthReady({
      ...fixture.args,
      codexHomePath: null
    })
  })
})

function createFixture(): {
  root: string
  home: string
  args: Parameters<typeof waitForManagedCodexAuthReady>[0]
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-managed-codex-auth-'))
  roots.push(root)
  const home = join(root, 'account', 'home')
  mkdirSync(home, { recursive: true })
  const account = {
    id: 'account-1',
    managedHomePath: home,
    managedHomeRuntime: 'host'
  } as CodexManagedAccount
  return {
    root,
    home,
    args: {
      codexHomePath: home,
      settings: { codexManagedAccounts: [account] } as GlobalSettings,
      target: { runtime: 'host' }
    }
  }
}

function writeAuth(home: string, auth: object): void {
  writeFileSync(join(home, 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
}
