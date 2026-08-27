import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  gcStaleWorktreeMeta,
  normalizeWorktreeLinkedItemMetadata,
  WORKTREE_META_GC_GRACE_MS
} from './worktree-metadata-normalization'

// Only the presence of an entry matters here; the normalizer never reads its linked-item fields.
function makeMeta(): WorktreeMeta {
  return { createdAt: 1 } as WorktreeMeta
}

function makeState(overrides: Partial<PersistedState>): PersistedState {
  return {
    worktreeMeta: {},
    worktreeLineageById: {},
    workspaceLineageByChildKey: {},
    ...overrides
  } as PersistedState
}

describe('normalizeWorktreeLinkedItemMetadata', () => {
  it('reports a null lineage map repair as changed so the load path re-saves it', () => {
    const state = makeState({
      worktreeMeta: { 'r1::/tmp/wt': makeMeta() },
      worktreeLineageById: null as unknown as PersistedState['worktreeLineageById']
    })

    // Without this the map stays null on disk and is repaired again on every reload.
    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.worktreeLineageById).toEqual({})
  })

  it('reports a null child-key lineage map repair as changed', () => {
    const state = makeState({
      worktreeMeta: {},
      workspaceLineageByChildKey: null as unknown as PersistedState['workspaceLineageByChildKey']
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.workspaceLineageByChildKey).toEqual({})
  })
  it('repairs malformed canonical metadata and alias maps', () => {
    const state = makeState({
      worktreeMetaByIdentity: null as unknown as PersistedState['worktreeMetaByIdentity'],
      worktreeIdentityAliases: {
        'local|r1::/tmp/wt': ['wt2:local:one', 'wt2:local:one', '', 42]
      } as unknown as PersistedState['worktreeIdentityAliases']
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.worktreeMetaByIdentity).toEqual({})
    // A key with no backing row is what turns the next write into an ambiguous alias, so it goes.
    expect(state.worktreeIdentityAliases).toEqual({})
  })

  it('keeps alias keys that still resolve to a metadata row', () => {
    const state = makeState({
      worktreeMetaByIdentity: { 'wt2:local:one': makeMeta() },
      worktreeIdentityAliases: { 'local|r1::/tmp/wt': ['wt2:local:one'] }
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(false)
    expect(state.worktreeIdentityAliases).toEqual({ 'local|r1::/tmp/wt': ['wt2:local:one'] })
  })

  it('drops malformed canonical metadata entries', () => {
    const state = makeState({
      worktreeMetaByIdentity: {
        valid: makeMeta(),
        malformed: null
      } as unknown as PersistedState['worktreeMetaByIdentity']
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(true)
    expect(state.worktreeMetaByIdentity).toEqual({ valid: makeMeta() })
  })

  it('leaves already-normalized state clean', () => {
    const state = makeState({
      worktreeMeta: { 'r1::/tmp/wt': makeMeta() }
    })

    expect(normalizeWorktreeLinkedItemMetadata(state)).toBe(false)
  })
})

describe('gcStaleWorktreeMeta', () => {
  it('reclaims the identity rows of a collected worktree', () => {
    const worktreeId = 'r1::/definitely/missing/orca/path'
    const identityKey = 'wt2:local:dead'
    const remoteIdentityKey = 'wt2:ssh:live'
    const state = makeState({
      repos: [],
      projects: [],
      worktreeMeta: {
        [worktreeId]: {
          hostId: 'local',
          instanceId: 'dead',
          displayName: 'dead',
          lastActivityAt: Date.now() - WORKTREE_META_GC_GRACE_MS - 1
        } as unknown as WorktreeMeta
      },
      worktreeMetaByIdentity: { [identityKey]: makeMeta(), [remoteIdentityKey]: makeMeta() },
      worktreeIdentityAliases: {
        [`local|${worktreeId}`]: [identityKey],
        [`ssh:conn-1|${worktreeId}`]: [remoteIdentityKey]
      }
    })

    expect(gcStaleWorktreeMeta(state)).toBe(1)
    // A surviving alias would re-attach this dead metadata to a worktree later
    // created at the same repoId::path, and nothing else ever reclaims it.
    expect(state.worktreeMetaByIdentity).toEqual({ [remoteIdentityKey]: expect.anything() })
    expect(state.worktreeIdentityAliases).toEqual({
      [`ssh:conn-1|${worktreeId}`]: [remoteIdentityKey]
    })
  })
})
