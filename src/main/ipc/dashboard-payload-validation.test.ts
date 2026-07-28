import { describe, expect, it } from 'vitest'
import type { DashboardSnapshot } from '../../shared/dashboard-snapshot'
import {
  admitDashboardSnapshot,
  isDashboardRevealAgentArgs,
  isDashboardSnapshot
} from './dashboard-payload-validation'

const SNAPSHOT = {
  generatedAt: 1_700_000_000_000,
  cards: [
    {
      paneKey: 'tab-1:leaf-1',
      ptyId: 'pty-1',
      agentType: 'codex',
      bucket: 'attention',
      dotState: 'waiting',
      task: 'Review the dashboard',
      lastUserMessage: 'Please review this',
      lastAgentMessage: 'I need a decision.',
      repoId: 'repo-1',
      worktreeId: 'worktree-1',
      tabId: 'tab-1',
      leafId: 'leaf-1',
      repoName: 'Orca',
      worktreeName: 'Dashboard',
      workspaceStatusId: 'in-review',
      workspaceStatusLabel: 'In review',
      workspaceStatusColor: 'emerald',
      hasReview: true,
      review: { number: 11012, state: 'open' },
      subagents: [{ id: 'child-1', name: 'Review loop', dotState: 'working' }],
      startedAt: 1_699_999_000_000,
      finishedAt: null,
      stateChangedAt: 1_699_999_500_000,
      unseen: true,
      askSummary: '{"question":"Proceed?"}'
    }
  ],
  showIdle: false,
  filterOptions: {
    projects: [{ id: 'repo-1', label: 'Orca' }],
    workspaceStatuses: [{ id: 'in-review', label: 'In review', color: 'emerald' }]
  }
} satisfies DashboardSnapshot

describe('dashboard payload validation', () => {
  it('accepts a complete dashboard snapshot', () => {
    expect(isDashboardSnapshot(SNAPSHOT)).toBe(true)
  })

  it('rejects malformed or unbounded snapshot fields', () => {
    expect(isDashboardSnapshot({ ...SNAPSHOT, generatedAt: Number.NaN })).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], bucket: 'unexpected' }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], lastAgentMessage: 'x'.repeat(8_001) }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], review: { number: 0, state: 'open' } }]
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], subagents: [{ id: '', name: 'bad', dotState: 'idle' }] }]
      })
    ).toBe(false)
  })

  it('accepts repo icons a pop-out can safely render, and rejects the rest', () => {
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        repoIconsByRepoId: {
          'repo-1': { type: 'lucide', name: 'Rocket' },
          'repo-2': null,
          'repo-3': {
            type: 'image',
            src: 'https://github.com/anthropics.png?size=64',
            source: 'github'
          }
        }
      })
    ).toBe(true)
    // Absent entirely: a pop-out on older code still gets its snapshot.
    expect(isDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: undefined })).toBe(true)

    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        repoIconsByRepoId: {
          'repo-1': { type: 'image', src: 'javascript:alert(1)', source: 'file' }
        }
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        repoIconsByRepoId: { 'repo-1': { type: 'nonsense' } }
      })
    ).toBe(false)
    expect(isDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: [] })).toBe(false)
  })

  it('accepts bounded filter options independently of cards', () => {
    expect(isDashboardSnapshot({ ...SNAPSHOT, cards: [] })).toBe(true)
    expect(isDashboardSnapshot({ ...SNAPSHOT, filterOptions: undefined })).toBe(true)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        filterOptions: {
          ...SNAPSHOT.filterOptions,
          projects: [{ id: '', label: 'Invalid' }]
        }
      })
    ).toBe(false)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        filterOptions: {
          ...SNAPSHOT.filterOptions,
          workspaceStatuses: [{ id: 'todo', label: 'x'.repeat(1_025) }]
        }
      })
    ).toBe(false)
  })

  it('bounds the conversation name', () => {
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], conversationName: 'Sparse-checkout parser' }]
      })
    ).toBe(true)
    expect(
      isDashboardSnapshot({
        ...SNAPSHOT,
        cards: [{ ...SNAPSHOT.cards[0], conversationName: 'x'.repeat(1_025) }]
      })
    ).toBe(false)
  })

  // Why: the pop-out replays the last accepted snapshot, so rejecting the whole
  // board over one card froze every other agent's status until it was renamed.
  describe('admitDashboardSnapshot', () => {
    it('drops only the offending card and keeps the rest of the board', () => {
      const good = SNAPSHOT.cards[0]
      const bad = { ...good, paneKey: 'tab-2:leaf-2', conversationName: 'x'.repeat(1_025) }

      const admitted = admitDashboardSnapshot({ ...SNAPSHOT, cards: [good, bad] })

      expect(admitted?.droppedCardCount).toBe(1)
      expect(admitted?.snapshot.cards.map((card) => card.paneKey)).toEqual(['tab-1:leaf-1'])
    })

    it('reports nothing dropped for a fully valid snapshot', () => {
      const admitted = admitDashboardSnapshot(SNAPSHOT)

      expect(admitted?.droppedCardCount).toBe(0)
      expect(admitted?.snapshot.cards).toHaveLength(1)
    })

    it('still rejects a snapshot whose own shape is unusable', () => {
      expect(admitDashboardSnapshot({ ...SNAPSHOT, generatedAt: Number.NaN })).toBeNull()
      expect(admitDashboardSnapshot({ ...SNAPSHOT, cards: 'nope' })).toBeNull()
      expect(admitDashboardSnapshot({ ...SNAPSHOT, repoIconsByRepoId: [] })).toBeNull()
    })
  })

  // Why: sanitizing an image icon decodes the whole payload to read a 24-byte
  // header, and the renderer republishes the same icons every 250 ms.
  it('validates a repeated image icon without re-decoding it every publish', () => {
    const src = `data:image/png;base64,${Buffer.concat([
      Buffer.from([
        137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 64, 0, 0, 0, 64, 8,
        6, 0, 0, 0
      ]),
      Buffer.alloc(256 * 1024, 7)
    ]).toString('base64')}`
    const snapshot = {
      ...SNAPSHOT,
      repoIconsByRepoId: Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [
          `repo-${index}`,
          { type: 'image', src, source: 'upload' }
        ])
      )
    }

    expect(isDashboardSnapshot(snapshot)).toBe(true)
    const start = performance.now()
    for (let run = 0; run < 20; run += 1) {
      expect(isDashboardSnapshot(snapshot)).toBe(true)
    }
    const perPublishMs = (performance.now() - start) / 20

    // Uncached this costs ~37 ms per publish; the cached path is well under 5 ms
    // even on a loaded CI box.
    expect(perPublishMs).toBeLessThan(5)
  })

  it('requires complete bounded reveal routing', () => {
    expect(
      isDashboardRevealAgentArgs({
        repoId: 'repo-1',
        worktreeId: 'worktree-1',
        tabId: 'tab-1',
        leafId: null
      })
    ).toBe(true)
    expect(
      isDashboardRevealAgentArgs({ repoId: 'repo-1', worktreeId: 'worktree-1', tabId: '' })
    ).toBe(false)
  })
})
