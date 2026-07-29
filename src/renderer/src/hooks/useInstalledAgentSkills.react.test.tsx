// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DiscoveredSkill,
  SkillDiscoveryResult,
  SkillDiscoveryTarget
} from '../../../shared/skills'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import {
  GLOBAL_AGENT_SKILL_SOURCE_KINDS,
  type InstalledAgentSkillState,
  _installedAgentSkillDiscoveryInternalsForTests,
  notifyInstalledAgentSkillsChanged,
  useInstalledAgentSkillNames
} from './useInstalledAgentSkills'

let root: Root | null = null
let container: HTMLDivElement | null = null
let latestState: InstalledAgentSkillState | null = null
const renderedStates: InstalledAgentSkillState[] = []

function skill(overrides: Partial<DiscoveredSkill>): DiscoveredSkill {
  return {
    id: 'skill-1',
    name: 'Example Skill',
    description: null,
    providers: ['agent-skills'],
    sourceKind: 'home',
    sourceLabel: 'Agent skills home',
    rootPath: '/Users/test/.agents/skills',
    directoryPath: '/Users/test/.agents/skills/example-skill',
    skillFilePath: '/Users/test/.agents/skills/example-skill/SKILL.md',
    installed: true,
    fileCount: 1,
    updatedAt: null,
    ...overrides
  }
}

function discoveryResult(skills: DiscoveredSkill[] = []): SkillDiscoveryResult {
  return {
    skills,
    sources: [],
    scannedAt: Date.now()
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

const LINEAR_AGENT_SKILL_NAMES = ['orca-linear', 'linear-tickets'] as const

const projectWslRuntime: ProjectExecutionRuntimeResolution = {
  status: 'resolved',
  runtime: {
    kind: 'wsl',
    hostPlatform: 'wsl',
    projectId: 'repo-1',
    distro: 'Ubuntu',
    reason: 'project-override',
    cacheKey: 'repo-1:wsl:Ubuntu'
  }
}

function Probe({ discoveryTarget }: { discoveryTarget?: SkillDiscoveryTarget }): null {
  latestState = useInstalledAgentSkillNames(LINEAR_AGENT_SKILL_NAMES, {
    discoveryTarget,
    sourceKinds: GLOBAL_AGENT_SKILL_SOURCE_KINDS
  })
  renderedStates.push(latestState)
  return null
}

async function renderProbe(discoveryTarget?: SkillDiscoveryTarget): Promise<void> {
  if (!container) {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  }
  await act(async () => {
    root?.render(<Probe discoveryTarget={discoveryTarget} />)
  })
}

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount()
    })
  }
  root = null
  container?.remove()
  container = null
  latestState = null
  renderedStates.length = 0
  _installedAgentSkillDiscoveryInternalsForTests.reset()
  vi.restoreAllMocks()
  Reflect.deleteProperty(window, 'api')
})

describe('useInstalledAgentSkill', () => {
  it('ignores stale discovery results after the discovery target changes', async () => {
    const hostScan = deferred<SkillDiscoveryResult>()
    const wslScan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockReturnValueOnce(hostScan.promise)
      .mockReturnValueOnce(wslScan.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    await renderProbe({ runtime: 'wsl', wslDistro: 'Fedora' })

    wslScan.resolve(discoveryResult([]))
    await act(async () => {
      await wslScan.promise
    })

    expect(latestState?.installed).toBe(false)

    hostScan.resolve(discoveryResult([skill({ name: 'linear-tickets' })]))
    await act(async () => {
      await hostScan.promise
    })

    expect(latestState?.installed).toBe(false)
    expect(discover).toHaveBeenNthCalledWith(1, undefined)
    expect(discover).toHaveBeenNthCalledWith(2, { runtime: 'wsl', wslDistro: 'Fedora' })
  })

  it('ignores same-target background discovery results when a forced refresh is waiting', async () => {
    const backgroundScan = deferred<SkillDiscoveryResult>()
    const forcedScan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockReturnValueOnce(backgroundScan.promise)
      .mockReturnValueOnce(forcedScan.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()

    const forcedRefresh = latestState?.refresh() ?? Promise.resolve()

    backgroundScan.resolve(discoveryResult([skill({ name: 'linear-tickets' })]))
    await act(async () => {
      await backgroundScan.promise
      await Promise.resolve()
    })

    expect(latestState?.installed).toBe(false)
    expect(discover).toHaveBeenCalledTimes(2)

    forcedScan.resolve(discoveryResult([]))
    await act(async () => {
      await forcedRefresh
    })

    expect(latestState?.installed).toBe(false)
    expect(discover).toHaveBeenNthCalledWith(1, undefined)
    expect(discover).toHaveBeenNthCalledWith(2, undefined)
  })

  it('returns installed from refresh when a legacy Linear skill is discovered', async () => {
    const backgroundScan = deferred<SkillDiscoveryResult>()
    const forcedScan = deferred<SkillDiscoveryResult>()
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockReturnValueOnce(backgroundScan.promise)
      .mockReturnValueOnce(forcedScan.promise)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()

    const forcedRefresh = latestState?.refresh() ?? Promise.resolve(false)
    backgroundScan.resolve(discoveryResult([]))
    await act(async () => {
      await backgroundScan.promise
    })

    forcedScan.resolve(discoveryResult([skill({ name: 'linear-tickets' })]))
    let installed = false
    await act(async () => {
      installed = await forcedRefresh
    })

    expect(installed).toBe(true)
    expect(latestState?.installed).toBe(true)
  })

  it('detects a legacy Linear install through WSL skill discovery', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    await act(async () => {
      await Promise.resolve()
    })

    expect(latestState?.installed).toBe(true)
    expect(discover).toHaveBeenCalledWith({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('detects a legacy Linear install through project-runtime skill discovery', async () => {
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe({ projectRuntime: projectWslRuntime })
    await act(async () => {
      await Promise.resolve()
    })

    expect(latestState?.installed).toBe(true)
    expect(discover).toHaveBeenCalledWith({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      projectRuntime: projectWslRuntime
    })
  })

  it('hydrates from the warm cache on its very first render pass', async () => {
    // Why: several always-mounted surfaces read this hook; a remount that starts
    // empty flashes their installed state off until the next scan settles.
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    expect(latestState?.installed).toBe(true)

    await act(async () => {
      root?.unmount()
    })
    root = null
    container = null
    renderedStates.length = 0
    await renderProbe()

    // The first render pass, before any effect runs, must already be settled.
    expect(renderedStates[0]?.loading).toBe(false)
    expect(renderedStates[0]?.installed).toBe(true)
  })

  it('hydrates from the warm cache when the discovery target changes', async () => {
    // Why: switching project or runtime environment must not blank an already
    // scanned target back to loading.
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe({ runtime: 'wsl', wslDistro: 'Ubuntu' })
    await act(async () => {
      await Promise.resolve()
    })
    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    renderedStates.length = 0

    await renderProbe({ runtime: 'wsl', wslDistro: 'Ubuntu' })

    expect(renderedStates[0]?.loading).toBe(false)
    expect(renderedStates[0]?.installed).toBe(true)
  })

  it('notifies mounted surfaces when installed skills change', async () => {
    // Why: the cache clear alone is inert — the DOM event is what makes every
    // mounted surface re-check after an install completes in a terminal.
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValueOnce(discoveryResult([]))
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe()
    await act(async () => {
      await Promise.resolve()
    })
    expect(latestState?.installed).toBe(false)

    await act(async () => {
      notifyInstalledAgentSkillsChanged()
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })

    expect(latestState?.installed).toBe(true)
  })

  it('empties the discovery cache when an install notification fires', async () => {
    // Why: notifyInstalledAgentSkillsChanged is the only wire from every install,
    // uninstall and update call site into the cache. Assert the cache directly —
    // a mounted component would force a rescan and hide a missing invalidation.
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockResolvedValueOnce(discoveryResult([]))
      .mockResolvedValue(discoveryResult([skill({ name: 'linear-tickets' })]))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    const { discoverInstalledAgentSkills } = _installedAgentSkillDiscoveryInternalsForTests
    await discoverInstalledAgentSkills(false, undefined)
    await expect(discoverInstalledAgentSkills(false, undefined)).resolves.toEqual(
      expect.objectContaining({ skills: [] })
    )
    expect(discover).toHaveBeenCalledTimes(1)

    notifyInstalledAgentSkillsChanged()

    await expect(discoverInstalledAgentSkills(false, undefined)).resolves.toEqual(
      expect.objectContaining({ skills: [expect.objectContaining({ name: 'linear-tickets' })] })
    )
    expect(discover).toHaveBeenCalledTimes(2)
  })

  it('does not rescan when a caller rebuilds an equivalent target object', async () => {
    // Why: callers derive the target inside a store-backed useMemo, so unrelated
    // store writes hand this hook a new object with the same discovery key.
    const discover = vi
      .fn<(target?: SkillDiscoveryTarget) => Promise<SkillDiscoveryResult>>()
      .mockRejectedValue(new Error('runtime host unreachable'))
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { skills: { discover } }
    })

    await renderProbe({ projectRuntime: projectWslRuntime })
    await act(async () => {
      await Promise.resolve()
    })
    expect(discover).toHaveBeenCalledTimes(1)

    for (let rebuild = 0; rebuild < 5; rebuild += 1) {
      await renderProbe({ projectRuntime: { ...projectWslRuntime } })
      await act(async () => {
        await Promise.resolve()
      })
    }

    // A failed scan caches nothing, so an unstable target identity would issue a
    // fresh discovery per store write for as long as the host stays unreachable.
    expect(discover).toHaveBeenCalledTimes(1)
    expect(latestState?.error).toBe('runtime host unreachable')
  })
})
