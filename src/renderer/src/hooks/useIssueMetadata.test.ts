import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubAssignableUser,
  LinearLabel,
  LinearMember,
  LinearWorkflowState
} from '../../../shared/types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  linearTeamLabels,
  linearTeamMembers,
  linearTeamStates
} from '@/runtime/runtime-linear-client'
import {
  clearGitHubMetadataCache,
  clearLinearMetadataCache,
  useRepoAssignees,
  useRepoLabels,
  useTeamLabels,
  useTeamMembers,
  useTeamStates
} from './useIssueMetadata'

const hookRuntime = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  refs: [] as { current: unknown }[],
  refIndex: 0,
  stateIndex: 0,
  states: [] as unknown[]
}))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useEffect: vi.fn((effect: () => void | (() => void)) => {
      hookRuntime.effects.push(effect)
    }),
    useRef: vi.fn((initial: unknown) => {
      const index = hookRuntime.refIndex++
      hookRuntime.refs[index] ??= { current: initial }
      return hookRuntime.refs[index]
    }),
    useState: vi.fn((initial: unknown) => {
      const index = hookRuntime.stateIndex++
      if (hookRuntime.states[index] === undefined) {
        hookRuntime.states[index] = typeof initial === 'function' ? initial() : initial
      }
      const setState = (next: unknown): void => {
        hookRuntime.states[index] =
          typeof next === 'function'
            ? (next as (previous: unknown) => unknown)(hookRuntime.states[index])
            : next
      }
      return [hookRuntime.states[index], setState]
    })
  }
})

vi.mock('@/runtime/runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn((settings?: { activeRuntimeEnvironmentId?: string | null }) => {
    const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
    return environmentId ? { kind: 'environment', environmentId } : { kind: 'local' }
  })
}))

vi.mock('@/runtime/runtime-linear-client', () => ({
  linearTeamLabels: vi.fn(),
  linearTeamMembers: vi.fn(),
  linearTeamStates: vi.fn()
}))

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

const listLabels = vi.fn()
const listAssignableUsers = vi.fn()

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function resetHookMemory(): void {
  hookRuntime.effects = []
  hookRuntime.refs = []
  hookRuntime.refIndex = 0
  hookRuntime.stateIndex = 0
  hookRuntime.states = []
}

function renderHook<T>(hook: () => T): T {
  hookRuntime.effects = []
  hookRuntime.refIndex = 0
  hookRuntime.stateIndex = 0
  return hook()
}

async function runEffects(): Promise<void> {
  const effects = [...hookRuntime.effects]
  hookRuntime.effects = []
  for (const effect of effects) {
    effect()
  }
  await Promise.resolve()
  await Promise.resolve()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

function stateAt<T>(index = 0): T {
  return hookRuntime.states[index] as T
}

function makeAssignee(overrides: Partial<GitHubAssignableUser> = {}): GitHubAssignableUser {
  return {
    login: 'mona',
    name: 'Mona',
    avatarUrl: '',
    ...overrides
  }
}

function makeState(overrides: Partial<LinearWorkflowState> = {}): LinearWorkflowState {
  return {
    id: 'state-1',
    name: 'Todo',
    type: 'unstarted',
    color: '#999999',
    position: 1,
    ...overrides
  }
}

function makeLabel(overrides: Partial<LinearLabel> = {}): LinearLabel {
  return {
    id: 'label-1',
    name: 'Bug',
    color: '#ff0000',
    ...overrides
  }
}

function makeMember(overrides: Partial<LinearMember> = {}): LinearMember {
  return {
    id: 'member-1',
    displayName: 'Mona',
    ...overrides
  }
}

beforeEach(() => {
  resetHookMemory()
  vi.clearAllMocks()
  clearGitHubMetadataCache()
  clearLinearMetadataCache()
  listLabels.mockResolvedValue(['bug', 'feature'])
  listAssignableUsers.mockResolvedValue([makeAssignee()])
  vi.mocked(linearTeamStates).mockResolvedValue([makeState()])
  vi.mocked(linearTeamLabels).mockResolvedValue([makeLabel()])
  vi.mocked(linearTeamMembers).mockResolvedValue([makeMember()])
  vi.stubGlobal('window', {
    api: {
      gh: {
        listLabels,
        listAssignableUsers
      }
    }
  })
})

afterEach(() => {
  clearGitHubMetadataCache()
  clearLinearMetadataCache()
  vi.unstubAllGlobals()
})

describe('useIssueMetadata GitHub hooks', () => {
  it('loads local repo labels, reuses fresh cache, and serves cache to new hook instances', async () => {
    expect(renderHook(() => useRepoLabels('/repo', 'repo-1'))).toEqual({
      data: [],
      loading: false,
      error: null
    })
    await runEffects()

    expect(listLabels).toHaveBeenCalledWith({ repoPath: '/repo', repoId: 'repo-1' })
    expect(stateAt()).toEqual({ data: ['bug', 'feature'], loading: false, error: null })

    renderHook(() => useRepoLabels('/repo', 'repo-1'))
    await runEffects()
    expect(listLabels).toHaveBeenCalledTimes(1)

    resetHookMemory()
    renderHook(() => useRepoLabels('/repo', 'repo-1'))
    await runEffects()
    expect(stateAt()).toEqual({ data: ['bug', 'feature'], loading: false, error: null })
    expect(listLabels).toHaveBeenCalledTimes(1)
  })

  it('loads repo-id labels and ignores stale completions', async () => {
    const first = deferred<string[]>()
    const second = deferred<string[]>()
    listLabels.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)

    renderHook(() => useRepoLabels(null, 'repo-1'))
    await runEffects()
    renderHook(() => useRepoLabels(null, 'repo-2'))
    await runEffects()

    first.resolve(['stale'])
    await runEffects()
    expect(stateAt()).toEqual({ data: [], loading: true, error: null })

    second.resolve(['fresh'])
    await runEffects()

    expect(callRuntimeRpc).not.toHaveBeenCalled()
    expect(listLabels).toHaveBeenNthCalledWith(1, { repoPath: '', repoId: 'repo-1' })
    expect(listLabels).toHaveBeenNthCalledWith(2, { repoPath: '', repoId: 'repo-2' })
    expect(stateAt()).toEqual({ data: ['fresh'], loading: false, error: null })
  })

  it('loads assignable users and reports request errors', async () => {
    renderHook(() => useRepoAssignees('/repo', 'repo-1'))
    await runEffects()
    expect(listAssignableUsers).toHaveBeenCalledWith({ repoPath: '/repo', repoId: 'repo-1' })
    expect(stateAt()).toEqual({ data: [makeAssignee()], loading: false, error: null })

    resetHookMemory()
    clearGitHubMetadataCache()
    listAssignableUsers.mockRejectedValueOnce(new Error('assignee failure'))
    renderHook(() => useRepoAssignees('/repo', 'repo-1'))
    await runEffects()

    expect(stateAt()).toEqual({ data: [], loading: false, error: 'assignee failure' })
  })
})

describe('useIssueMetadata Linear hooks', () => {
  it('loads Linear team metadata and separates local/runtime cache keys', async () => {
    renderHook(() => useTeamStates('team-1', null))
    await runEffects()
    expect(linearTeamStates).toHaveBeenCalledWith(null, 'team-1', undefined)
    expect(stateAt()).toEqual({ data: [makeState()], loading: false, error: null })

    renderHook(() => useTeamStates('team-1', null))
    await runEffects()
    expect(linearTeamStates).toHaveBeenCalledTimes(1)

    resetHookMemory()
    renderHook(() => useTeamStates('team-1', { activeRuntimeEnvironmentId: 'env-1' }))
    await runEffects()
    expect(linearTeamStates).toHaveBeenCalledWith(
      { activeRuntimeEnvironmentId: 'env-1' },
      'team-1',
      undefined
    )
    expect(linearTeamStates).toHaveBeenCalledTimes(2)
  })

  it('loads labels, members, null-team noops, and Linear errors', async () => {
    renderHook(() => useTeamLabels('team-1', null))
    await runEffects()
    expect(linearTeamLabels).toHaveBeenCalledWith(null, 'team-1', undefined)
    expect(stateAt()).toEqual({ data: [makeLabel()], loading: false, error: null })

    resetHookMemory()
    renderHook(() => useTeamMembers(null, null))
    await runEffects()
    expect(linearTeamMembers).not.toHaveBeenCalled()
    expect(stateAt()).toEqual({ data: [], loading: false, error: null })

    resetHookMemory()
    vi.mocked(linearTeamMembers).mockRejectedValueOnce(new Error('member failure'))
    renderHook(() => useTeamMembers('team-1', null))
    await runEffects()

    expect(linearTeamMembers).toHaveBeenCalledWith(null, 'team-1', undefined)
    expect(stateAt()).toEqual({ data: [], loading: false, error: 'member failure' })
  })
})
