import { describe, expect, it } from 'vitest'
import type { ProjectExecutionRuntimeResolution } from '../../../../shared/project-execution-runtime'
import { getLinearPromptSkillDiscoveryTarget } from './linear-agent-skill-runtime'

const hostRuntime = { runtime: 'host', label: 'Windows host' } as const
const wslRuntime = { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' } as const

const projectRuntime: ProjectExecutionRuntimeResolution = {
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

describe('getLinearPromptSkillDiscoveryTarget', () => {
  it('scopes a project runtime target by the runtime environment', () => {
    expect(
      getLinearPromptSkillDiscoveryTarget(hostRuntime, projectRuntime, 'env-remote-1')
    ).toEqual({ projectRuntime, executionHostId: 'env-remote-1' })
  })

  it('scopes a WSL target by the runtime environment', () => {
    expect(getLinearPromptSkillDiscoveryTarget(wslRuntime, undefined, 'env-remote-1')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      executionHostId: 'env-remote-1'
    })
  })

  it('scopes a bare host target by the runtime environment', () => {
    expect(getLinearPromptSkillDiscoveryTarget(hostRuntime, undefined, 'env-remote-1')).toEqual({
      executionHostId: 'env-remote-1'
    })
  })

  it('omits the scope for the local runtime on every branch', () => {
    expect(getLinearPromptSkillDiscoveryTarget(hostRuntime, projectRuntime, null)).toEqual({
      projectRuntime
    })
    expect(getLinearPromptSkillDiscoveryTarget(wslRuntime, undefined, '  ')).toEqual({
      runtime: 'wsl',
      wslDistro: 'Ubuntu'
    })
    expect(getLinearPromptSkillDiscoveryTarget(hostRuntime, undefined, undefined)).toBeUndefined()
  })
})
