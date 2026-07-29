// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillDiscoveryTarget } from '../../../shared/skills'

type StoreState = Record<string, unknown>

let storeState: StoreState = {}

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(storeState)
}))

vi.mock('@/lib/windows-terminal-capabilities', () => ({
  useWindowsTerminalCapabilities: () => ({
    isLoading: false,
    wslAvailable: false,
    wslDistros: null
  })
}))

const { useActiveProjectSkillRuntime } = await import('./useActiveProjectSkillRuntime')

let root: Root | null = null
let container: HTMLDivElement | null = null
let latestTarget: SkillDiscoveryTarget | undefined

function Probe(): null {
  latestTarget = useActiveProjectSkillRuntime().discoveryTarget
  return null
}

async function renderProbe(): Promise<void> {
  await act(async () => {
    root?.render(<Probe />)
  })
}

let platform: NodeJS.Platform = 'darwin'

beforeEach(() => {
  // Why: non-win32 resolves no project runtime, so darwin exercises the branch
  // that carries the runtime-host cache scope on its own.
  platform = 'darwin'
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { platform: { get: () => ({ platform }) } }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => {
    root?.unmount()
  })
  root = null
  container?.remove()
  container = null
  latestTarget = undefined
  storeState = {}
  Reflect.deleteProperty(window, 'api')
})

describe('useActiveProjectSkillRuntime', () => {
  it('carries the active runtime environment as the discovery scope', async () => {
    storeState = { settings: { activeRuntimeEnvironmentId: 'env-remote-1' } }
    await renderProbe()

    expect(latestTarget).toEqual({ executionHostId: 'env-remote-1' })
  })

  it('leaves the target unset for the local runtime', async () => {
    storeState = { settings: { activeRuntimeEnvironmentId: null } }
    await renderProbe()

    expect(latestTarget).toBeUndefined()
  })

  it('treats a blank environment id as local', async () => {
    storeState = { settings: { activeRuntimeEnvironmentId: '   ' } }
    await renderProbe()

    expect(latestTarget).toBeUndefined()
  })

  it('scopes a resolved Windows project runtime by the runtime environment', async () => {
    platform = 'win32'
    storeState = {
      activeRepoId: 'repo-1',
      activeWorktreeId: 'worktree-1',
      repos: [{ id: 'repo-1', path: 'C:\\src\\repo-1' }],
      worktreesByRepo: {
        'repo-1': [{ id: 'worktree-1', repoId: 'repo-1', path: 'C:\\src\\repo-1' }]
      },
      settings: {
        activeRuntimeEnvironmentId: 'env-remote-1',
        terminalWindowsShell: 'powershell.exe'
      }
    }
    await renderProbe()

    expect(latestTarget?.executionHostId).toBe('env-remote-1')
    expect(latestTarget?.projectRuntime).toEqual({
      status: 'resolved',
      runtime: {
        kind: 'windows-host',
        hostPlatform: 'win32',
        projectId: 'repo-1',
        reason: 'global-default',
        cacheKey: 'repo-1:windows-host'
      }
    })
  })

  it('re-scopes the target when the active runtime environment changes', async () => {
    storeState = { settings: { activeRuntimeEnvironmentId: 'env-remote-1' } }
    await renderProbe()
    expect(latestTarget).toEqual({ executionHostId: 'env-remote-1' })

    storeState = { settings: { activeRuntimeEnvironmentId: 'env-remote-2' } }
    await renderProbe()

    expect(latestTarget).toEqual({ executionHostId: 'env-remote-2' })
  })
})
