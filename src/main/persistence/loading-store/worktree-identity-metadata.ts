import { randomUUID } from 'node:crypto'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { normalizeStoredTaskSourceContext } from '../../../shared/task-source-context'
import { normalizeWorkspaceLinkedItem } from '../../../shared/workspace-linked-item'
import { isWorkspaceLinkedItemSourceContextMatch } from '../../../shared/workspace-linked-item-source-context'
import {
  canonicalWorktreeIdentity,
  composeWorktreeIdentityAlias
} from '../../../shared/worktree/identity'
import { DEFAULT_WORKSPACE_STATUS_ID } from '../../../shared/workspace-statuses'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from '../../../shared/worktree/host-qualified-identity'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { StoreRuntimeState } from './store-runtime-state'
import type { WriteSchedulingOperations } from './write-scheduling'
import { scheduleSave } from './write-scheduling'

type MetadataRuntime = Pick<StoreRuntimeState, 'state'>

function getDefaultWorktreeMeta(): WorktreeMeta {
  return {
    instanceId: randomUUID(),
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    linkedBitbucketPR: null,
    linkedAzureDevOpsPR: null,
    linkedGiteaPR: null,
    linkedWorkItem: null,
    linkedTaskSourceContext: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: Date.now(),
    lastActivityAt: 0,
    workspaceStatus: DEFAULT_WORKSPACE_STATUS_ID
  }
}

/**
 * Collapse an alias to the single identity it can resolve to, dropping keys whose
 * metadata is gone. Fails open on purpose: an ambiguous alias used to brick reads
 * and throw out of the worktree listing loop with no path back.
 */
function resolveAliasIdentityKey(
  state: PersistedState,
  alias: string
): { identityKey: string | undefined; changed: boolean } {
  const identityKeys = state.worktreeIdentityAliases?.[alias] ?? []
  if (identityKeys.length === 0) {
    return { identityKey: undefined, changed: false }
  }
  const resolvable = identityKeys.filter((key) => state.worktreeMetaByIdentity?.[key])
  const candidates = resolvable.length > 0 ? resolvable : identityKeys
  // Newest activity wins, then the greater key, so every host agrees on the survivor.
  const winner = candidates.reduce((best, key) => {
    const bestTouch = state.worktreeMetaByIdentity?.[best]?.lastActivityAt ?? 0
    const keyTouch = state.worktreeMetaByIdentity?.[key]?.lastActivityAt ?? 0
    if (keyTouch !== bestTouch) {
      return keyTouch > bestTouch ? key : best
    }
    return key > best ? key : best
  })
  if (identityKeys.length > 1) {
    // Reads need a deterministic row for the catalog, but preserving every alias
    // keeps an ambiguous instance recoverable and makes writes fail closed.
    return { identityKey: winner, changed: false }
  }
  return { identityKey: winner, changed: false }
}

/** Drop identity metadata no alias points at any more. */
export function pruneUnreferencedWorktreeIdentityMeta(state: PersistedState): boolean {
  const referenced = new Set(Object.values(state.worktreeIdentityAliases ?? {}).flat())
  let changed = false
  for (const identityKey of Object.keys(state.worktreeMetaByIdentity ?? {})) {
    if (!referenced.has(identityKey)) {
      delete state.worktreeMetaByIdentity?.[identityKey]
      changed = true
    }
  }
  return changed
}

function migrateLegacyWorktreeMetadata(
  state: PersistedState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): boolean {
  const meta = state.worktreeMeta[worktreeId]
  if (!meta || (meta.hostId !== undefined && meta.hostId !== executionHostId)) {
    return false
  }
  state.worktreeMetaByIdentity ??= {}
  state.worktreeIdentityAliases ??= {}
  let changed = false
  const instanceId = meta.instanceId ?? randomUUID()
  if (!meta.instanceId) {
    meta.instanceId = instanceId
    changed = true
  }
  if (!meta.hostId) {
    meta.hostId = executionHostId
    changed = true
  }
  const identityKey = canonicalWorktreeIdentity({
    worktreeId,
    executionHostId,
    instanceId
  })
  if (!state.worktreeMetaByIdentity[identityKey]) {
    state.worktreeMetaByIdentity[identityKey] = {
      ...meta,
      instanceId,
      hostId: executionHostId
    }
    changed = true
  }
  const alias = composeWorktreeIdentityAlias(executionHostId, worktreeId)
  const aliases = state.worktreeIdentityAliases[alias] ?? []
  if (aliases.length === 0) {
    state.worktreeIdentityAliases[alias] = [identityKey]
    changed = true
  }
  return changed
}

/** Drop the identity rows a locator owns, for one host or for every host. */
export function removeWorktreeMetadataForHost(
  state: PersistedState,
  worktreeId: string,
  executionHostId: ExecutionHostId | undefined
): boolean {
  let changed = false
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    if (getWorktreeIdFromHostIdentity(alias) !== worktreeId) {
      continue
    }
    if (
      executionHostId !== undefined &&
      getExecutionHostIdFromWorktreeHostIdentity(alias) !== executionHostId
    ) {
      continue
    }
    delete state.worktreeIdentityAliases?.[alias]
    changed = true
  }
  return pruneUnreferencedWorktreeIdentityMeta(state) || changed
}

/**
 * Re-point one host's alias at a renamed locator. Host-scoped on purpose: a local
 * folder move must not drag a remote host's alias to a path that host does not have.
 */
export function migrateWorktreeMetadataLocator(
  state: PersistedState,
  oldWorktreeId: string,
  newWorktreeId: string,
  executionHostId: ExecutionHostId
): boolean {
  if (oldWorktreeId === newWorktreeId) {
    return false
  }
  const oldAlias = composeWorktreeIdentityAlias(executionHostId, oldWorktreeId)
  const identityKeys = state.worktreeIdentityAliases?.[oldAlias]
  if (!identityKeys || identityKeys.length === 0) {
    return false
  }
  const newAlias = composeWorktreeIdentityAlias(executionHostId, newWorktreeId)
  state.worktreeIdentityAliases ??= {}
  // A taken destination keeps its own occupant; stranding the mover at the old locator loses less
  // than merging (which makes both unreadable) or dropping its row outright.
  if ((state.worktreeIdentityAliases[newAlias] ?? []).length > 0) {
    return false
  }
  state.worktreeIdentityAliases[newAlias] = [...identityKeys]
  delete state.worktreeIdentityAliases[oldAlias]
  return true
}
export function getWorktreeMetaForHost(
  runtime: MetadataRuntime,
  scheduling: WriteSchedulingOperations,
  worktreeId: string,
  executionHostId: ExecutionHostId
): WorktreeMeta | undefined {
  const state = runtime.state
  let changed = migrateLegacyWorktreeMetadata(state, worktreeId, executionHostId)
  const alias = composeWorktreeIdentityAlias(executionHostId, worktreeId)
  const resolved = resolveAliasIdentityKey(state, alias)
  changed = resolved.changed || changed
  if (changed) {
    scheduleSave(scheduling)
  }
  if (resolved.identityKey) {
    return state.worktreeMetaByIdentity?.[resolved.identityKey]
  }
  const legacy = state.worktreeMeta[worktreeId]
  return !legacy?.hostId || legacy.hostId === executionHostId ? legacy : undefined
}

/** Read-only host projection used by listings that must include canonical-only rows. */
export function getAllWorktreeMetaForHost(
  runtime: MetadataRuntime,
  executionHostId: ExecutionHostId
): Record<string, WorktreeMeta> {
  const state = runtime.state
  const projected: Record<string, WorktreeMeta> = {}
  for (const [worktreeId, meta] of Object.entries(state.worktreeMeta)) {
    if (!meta.hostId || meta.hostId === executionHostId) {
      projected[worktreeId] = meta
    }
  }
  for (const alias of Object.keys(state.worktreeIdentityAliases ?? {})) {
    if (getExecutionHostIdFromWorktreeHostIdentity(alias) !== executionHostId) {
      continue
    }
    const worktreeId = getWorktreeIdFromHostIdentity(alias)
    const identityKey = resolveAliasIdentityKey(state, alias).identityKey
    const meta = identityKey ? state.worktreeMetaByIdentity?.[identityKey] : undefined
    if (!worktreeId || !meta || (meta.hostId && meta.hostId !== executionHostId)) {
      continue
    }
    projected[worktreeId] =
      meta.hostId === executionHostId ? meta : { ...meta, hostId: executionHostId }
  }
  return projected
}

export function setWorktreeMetaForHost(
  runtime: MetadataRuntime,
  scheduling: WriteSchedulingOperations,
  worktreeId: string,
  executionHostId: ExecutionHostId,
  meta: Partial<WorktreeMeta>
): WorktreeMeta {
  const state = runtime.state
  migrateLegacyWorktreeMetadata(state, worktreeId, executionHostId)
  const alias = composeWorktreeIdentityAlias(executionHostId, worktreeId)
  const identityKeys = state.worktreeIdentityAliases?.[alias] ?? []
  if (identityKeys.length > 1 && meta.instanceId === undefined) {
    throw new Error('Worktree identity is ambiguous for this host and locator.')
  }
  const existingIdentityKey = resolveAliasIdentityKey(state, alias).identityKey
  const existingIdentityMeta = existingIdentityKey
    ? state.worktreeMetaByIdentity?.[existingIdentityKey]
    : undefined
  const legacy = state.worktreeMeta[worktreeId]
  const existing =
    existingIdentityMeta ??
    (!legacy?.hostId || legacy.hostId === executionHostId ? legacy : undefined)
  // An explicit instanceId is a deliberate rotation (see worktree-lineage-pruning), so it wins.
  const instanceId = meta.instanceId ?? existing?.instanceId ?? randomUUID()
  const identityKey = canonicalWorktreeIdentity({ worktreeId, executionHostId, instanceId })
  const updated = {
    ...(existing ?? getDefaultWorktreeMeta()),
    ...meta,
    instanceId,
    hostId: executionHostId
  }
  updated.linkedWorkItem = normalizeWorkspaceLinkedItem(updated.linkedWorkItem)
  const linkedTaskSourceContext = normalizeStoredTaskSourceContext(updated.linkedTaskSourceContext)
  updated.linkedTaskSourceContext = isWorkspaceLinkedItemSourceContextMatch(
    updated.linkedWorkItem,
    linkedTaskSourceContext
  )
    ? linkedTaskSourceContext
    : null
  state.worktreeMetaByIdentity ??= {}
  state.worktreeIdentityAliases ??= {}
  if (existingIdentityKey && existingIdentityKey !== identityKey) {
    delete state.worktreeMetaByIdentity[existingIdentityKey]
  }
  state.worktreeMetaByIdentity[identityKey] = updated
  state.worktreeIdentityAliases[alias] = [identityKey]
  // Keep the legacy projection only for the first known owner.
  if (!legacy || legacy.hostId === executionHostId) {
    state.worktreeMeta[worktreeId] = updated
  }
  scheduleSave(scheduling)
  return updated
}
