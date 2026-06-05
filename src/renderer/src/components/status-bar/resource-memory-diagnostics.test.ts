import { describe, expect, it } from 'vitest'
import type { MemorySnapshot } from '../../../../shared/types'
import type { UnifiedProjectGroup } from './mergeSnapshotAndSessions'
import {
  buildResourceMemoryDiagnostics,
  collectLocalSessionBreakdowns,
  countRemoteUnsampledSessions,
  getTopProcesses
} from './resource-memory-diagnostics'

function makeSnapshot(): MemorySnapshot {
  return {
    app: {
      cpu: 3,
      memory: 300 * 1024 * 1024,
      main: { cpu: 1, memory: 100 * 1024 * 1024 },
      renderer: { cpu: 2, memory: 200 * 1024 * 1024 },
      other: { cpu: 0, memory: 0 },
      history: [],
      processes: [
        {
          pid: 10,
          role: 'Renderer',
          label: 'Renderer process',
          command: 'Orca Helper --type=renderer',
          cpu: 2,
          memory: 200 * 1024 * 1024
        },
        {
          pid: 1,
          role: 'Main',
          label: 'Main process',
          command: 'Orca',
          cpu: 1,
          memory: 100 * 1024 * 1024
        }
      ]
    },
    worktrees: [],
    host: {
      totalMemory: 10 * 1024 * 1024 * 1024,
      freeMemory: 5 * 1024 * 1024 * 1024,
      usedMemory: 5 * 1024 * 1024 * 1024,
      memoryUsagePercent: 50,
      cpuCoreCount: 8,
      loadAverage1m: 0
    },
    totalCpu: 7,
    totalMemory: 700 * 1024 * 1024,
    collectedAt: Date.parse('2026-06-05T12:00:00.000Z')
  }
}

function makeRepos(): UnifiedProjectGroup[] {
  return [
    {
      repoId: 'orca',
      repoName: 'ORCA',
      cpu: 4,
      memory: 400 * 1024 * 1024,
      hasRemoteChildren: true,
      worktrees: [
        {
          worktreeId: 'orca::/repo/wt',
          worktreeName: 'wt',
          repoId: 'orca',
          repoName: 'ORCA',
          cpu: 4,
          memory: 400 * 1024 * 1024,
          history: [],
          hasLocalSamples: true,
          isRemote: false,
          sessions: [
            {
              sessionId: 's-local',
              paneKey: null,
              pid: 50,
              label: 'codex',
              bound: true,
              tabId: 'tab',
              cpu: 4,
              memory: 400 * 1024 * 1024,
              hasLocalSamples: true,
              processes: [
                {
                  pid: 51,
                  ppid: 50,
                  role: 'Agent CLI',
                  label: 'codex',
                  command: 'codex resume',
                  cpu: 4,
                  memory: 400 * 1024 * 1024
                }
              ]
            },
            {
              sessionId: 's-remote',
              paneKey: null,
              pid: 0,
              label: 'remote shell',
              bound: false,
              tabId: null,
              cpu: null,
              memory: null,
              hasLocalSamples: false,
              processes: []
            }
          ]
        }
      ]
    }
  ]
}

describe('resource memory diagnostics', () => {
  it('sorts process rows by memory descending', () => {
    const snapshot = makeSnapshot()
    expect(getTopProcesses(snapshot.app.processes, 2).map((p) => p.pid)).toEqual([10, 1])
  })

  it('collects local sessions while counting unsampled remote sessions separately', () => {
    const repos = makeRepos()
    expect(collectLocalSessionBreakdowns(repos).map((s) => s.session.sessionId)).toEqual([
      's-local'
    ])
    expect(countRemoteUnsampledSessions(repos)).toBe(1)
  })

  it('builds a compact copyable diagnostic summary', () => {
    const text = buildResourceMemoryDiagnostics({
      snapshot: makeSnapshot(),
      repos: makeRepos(),
      platformLabel: 'macOS',
      generatedAt: new Date('2026-06-05T12:00:00.000Z')
    })
    expect(text).toContain('[Orca Resource Manager]')
    expect(text).toContain('Tracked memory: 700.0 MB RSS')
    expect(text).toContain('Renderer: Renderer process (pid 10)')
    expect(text).toContain('ORCA / wt / codex: 400.0 MB RSS')
    expect(text).toContain('Remote sessions not sampled locally: 1')
  })
})
