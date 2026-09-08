import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  shouldSyncAllRuntimeSessionTabs,
  shouldApplyWebSessionTabsSnapshot,
  shouldBootstrapInitialWebRuntimeTerminal,
  shouldRespawnWebRuntimeTerminalAfterWake,
  shouldSyncRuntimeSessionTabs
} from './web-session-tabs-sync'
import { UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH } from '../../../shared/runtime-types'
import {
  ENV,
  HOST_SURFACE_ID,
  LEAF_ID,
  WT,
  makeSnapshot,
  resetWebSessionTabsSyncTestState
} from './web-session-tabs-sync-test-harness'
import {
  beginWebRuntimeInitialTerminalBootstrap,
  endWebRuntimeInitialTerminalBootstrap,
  isWebRuntimeInitialTerminalBootstrapInFlight
} from './web-runtime-initial-terminal-bootstrap'
import {
  clearWebSessionTabsTrackingForWorktree,
  clearWebSessionTabsTrackingForEnvironment
} from './web-session-tabs-sync/tracking-lifecycle'

vi.mock('../store', () => ({
  useAppStore: {
    setState: vi.fn()
  }
}))

describe('applyWebSessionTabsSnapshot', () => {
  beforeEach(resetWebSessionTabsSyncTestState)

  it('does not bootstrap a terminal from a stale empty active-worktree snapshot', () => {
    const ready = makeSnapshot([
      {
        type: 'terminal',
        id: HOST_SURFACE_ID,
        parentTabId: 'host-tab-1',
        leafId: LEAF_ID,
        title: 'Terminal',
        status: 'ready',
        terminal: 'term_host',
        isActive: true
      }
    ])
    const staleEmpty = makeSnapshot([], {
      publicationEpoch: ready.publicationEpoch,
      snapshotVersion: ready.snapshotVersion - 1,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(shouldApplyWebSessionTabsSnapshot(ready, ENV)).toBe(true)
    const staleIsFresh = shouldApplyWebSessionTabsSnapshot(staleEmpty, ENV)

    expect(staleIsFresh).toBe(false)
    expect(
      shouldBootstrapInitialWebRuntimeTerminal({
        event: { type: 'snapshot', ...staleEmpty },
        activeWorktreeId: WT,
        requestedInitialTerminal: false,
        snapshotIsFresh: staleIsFresh,
        localTerminalCount: 0,
        hasPersistedTerminalState: false
      })
    ).toBe(false)
  })

  it('does not bootstrap a terminal from a fresh empty snapshot when local terminals already exist', () => {
    const freshEmpty = makeSnapshot([], {
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(
      shouldBootstrapInitialWebRuntimeTerminal({
        event: { type: 'snapshot', ...freshEmpty },
        activeWorktreeId: WT,
        requestedInitialTerminal: false,
        snapshotIsFresh: true,
        localTerminalCount: 1,
        hasPersistedTerminalState: true
      })
    ).toBe(false)
  })

  // Why: the workspace the user emptied on purpose. STA-6173 — the mirror used to delete the row,
  // which reads back as "never initialized", so every focus of a runtime-owned workspace seeded a
  // terminal the local path had long since stopped seeding.
  it('does not bootstrap a terminal when an explicit empty row records the closed last terminal', () => {
    const freshEmpty = makeSnapshot([], {
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(
      shouldBootstrapInitialWebRuntimeTerminal({
        event: { type: 'snapshot', ...freshEmpty },
        activeWorktreeId: WT,
        requestedInitialTerminal: false,
        snapshotIsFresh: true,
        localTerminalCount: 0,
        hasPersistedTerminalState: true
      })
    ).toBe(false)
  })

  it('bootstraps a terminal for a workspace that has no terminal row at all', () => {
    const freshEmpty = makeSnapshot([], {
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(
      shouldBootstrapInitialWebRuntimeTerminal({
        event: { type: 'snapshot', ...freshEmpty },
        activeWorktreeId: WT,
        requestedInitialTerminal: false,
        snapshotIsFresh: true,
        localTerminalCount: 0,
        hasPersistedTerminalState: false
      })
    ).toBe(true)
  })

  // Why: a runtime that has published nothing for a worktree still answers a forced snapshot with a
  // synthesized empty frame (`UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH` at version 0). That is "ask me
  // later", not a host with zero terminals — seeding on it can duplicate a pane the host is about to
  // republish after a restart, so it must decline even when no terminal row exists yet.
  it('does not bootstrap on a synthesized unpublished frame with no terminal row', () => {
    const unpublished = makeSnapshot([], {
      publicationEpoch: UNPUBLISHED_WORKTREE_PUBLICATION_EPOCH,
      snapshotVersion: 0,
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(
      shouldBootstrapInitialWebRuntimeTerminal({
        event: { type: 'snapshot', ...unpublished },
        activeWorktreeId: WT,
        requestedInitialTerminal: false,
        snapshotIsFresh: true,
        localTerminalCount: 0,
        hasPersistedTerminalState: false
      })
    ).toBe(false)
  })

  // Why: the shared latch outlives the subscription closures, so a create RPC that never settles
  // during a disconnect would leave the per-worktree key set and suppress the next bootstrap after
  // reconnect. Tracking teardown must release it, mirroring the wake-respawn latch.
  it('releases the in-flight bootstrap latch when worktree tracking is cleared', () => {
    expect(beginWebRuntimeInitialTerminalBootstrap(WT)).toBe(true)
    expect(isWebRuntimeInitialTerminalBootstrapInFlight(WT)).toBe(true)

    clearWebSessionTabsTrackingForWorktree(ENV, WT)

    expect(isWebRuntimeInitialTerminalBootstrapInFlight(WT)).toBe(false)
    expect(beginWebRuntimeInitialTerminalBootstrap(WT)).toBe(true)
  })

  it('releases every in-flight bootstrap latch when the environment is torn down', () => {
    expect(beginWebRuntimeInitialTerminalBootstrap(WT)).toBe(true)
    expect(isWebRuntimeInitialTerminalBootstrapInFlight(WT)).toBe(true)

    clearWebSessionTabsTrackingForEnvironment(ENV)

    expect(isWebRuntimeInitialTerminalBootstrapInFlight(WT)).toBe(false)
  })

  // Why: the second half of STA-6173. One focus re-runs the subscription effect (environment,
  // connection generation and session-ready all settle during a workspace switch), and the old
  // closure-local flag re-armed with it, so both closures seeded before either create mirrored.
  it('declines a second bootstrap while one is already in flight for the worktree', () => {
    const freshEmpty = makeSnapshot([], {
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })
    const decide = (): boolean =>
      shouldBootstrapInitialWebRuntimeTerminal({
        event: { type: 'snapshot', ...freshEmpty },
        activeWorktreeId: WT,
        // What a freshly installed closure passes: its own flag is false, so only the shared latch
        // can stop it.
        requestedInitialTerminal: isWebRuntimeInitialTerminalBootstrapInFlight(WT),
        snapshotIsFresh: true,
        localTerminalCount: 0,
        hasPersistedTerminalState: false
      })

    expect(decide()).toBe(true)
    expect(beginWebRuntimeInitialTerminalBootstrap(WT)).toBe(true)
    expect(beginWebRuntimeInitialTerminalBootstrap(WT)).toBe(false)
    expect(decide()).toBe(false)

    endWebRuntimeInitialTerminalBootstrap(WT)
    expect(decide()).toBe(true)
  })

  it('does not respawn after wake when activation already requested a respawn', () => {
    const freshEmpty = makeSnapshot([], {
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(
      shouldRespawnWebRuntimeTerminalAfterWake({
        event: { type: 'snapshot', ...freshEmpty },
        activeWorktreeId: WT,
        requestedRespawnAfterWake: false,
        snapshotIsFresh: true,
        localTerminalCount: 1,
        hasLiveLocalPty: false,
        skipWakeRespawn: true
      })
    ).toBe(false)
  })

  it('respawns a terminal after wake when local slept tabs exist but the host snapshot is empty', () => {
    const freshEmpty = makeSnapshot([], {
      activeGroupId: null,
      activeTabId: null,
      activeTabType: null
    })

    expect(
      shouldRespawnWebRuntimeTerminalAfterWake({
        event: { type: 'snapshot', ...freshEmpty },
        activeWorktreeId: WT,
        requestedRespawnAfterWake: false,
        snapshotIsFresh: true,
        localTerminalCount: 1,
        hasLiveLocalPty: false
      })
    ).toBe(true)
  })

  it('syncs active session tabs for desktop remote runtime clients using the worktree owner', () => {
    expect(
      shouldSyncRuntimeSessionTabs({
        activeWorktreeId: WT,
        activeWorktreeRuntimeEnvironmentId: ENV,
        workspaceSessionReady: true
      })
    ).toBe(true)
    expect(
      shouldSyncRuntimeSessionTabs({
        activeWorktreeId: WT,
        activeWorktreeRuntimeEnvironmentId: null,
        workspaceSessionReady: true
      })
    ).toBe(false)
    expect(
      shouldSyncRuntimeSessionTabs({
        activeWorktreeId: WT,
        activeWorktreeRuntimeEnvironmentId: 'other-env',
        workspaceSessionReady: true
      })
    ).toBe(true)
    expect(
      shouldSyncRuntimeSessionTabs({
        activeWorktreeRuntimeEnvironmentId: ENV,
        workspaceSessionReady: true
      })
    ).toBe(false)
    expect(
      shouldSyncRuntimeSessionTabs({
        activeWorktreeId: WT,
        activeWorktreeRuntimeEnvironmentId: ENV,
        workspaceSessionReady: false
      })
    ).toBe(false)
  })

  it('starts the all-session mirror for desktop and paired web clients', () => {
    expect(
      shouldSyncAllRuntimeSessionTabs({
        activeRuntimeEnvironmentId: ENV,
        workspaceSessionReady: true
      })
    ).toBe(true)
    expect(
      shouldSyncAllRuntimeSessionTabs({
        activeRuntimeEnvironmentId: ENV,
        workspaceSessionReady: false
      })
    ).toBe(false)
  })
})
