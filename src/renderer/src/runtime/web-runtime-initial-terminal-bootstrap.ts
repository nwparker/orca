/**
 * Which runtime-owned workspaces already have an initial-terminal bootstrap in flight.
 *
 * The bootstrap used to be latched by a `let` inside the session-tabs subscription closure, which
 * made "one focus creates at most one terminal" true only for as long as that one closure lived.
 * Its effect re-runs whenever the environment, connection generation, pairing revision, or
 * session-ready flag settles — all of which move during a workspace switch — so a second closure
 * re-armed the flag while the first create was still in flight and seeded a second terminal
 * (STA-6173). This latch outlives the closures.
 *
 * It is keyed by environment AND worktree, not worktree alone: a worktree id is `repoId::path` with
 * no host component, so the same id can be live on two paired runtimes at once (STA-4343). Keying
 * per environment lets a per-environment teardown release only its own in-flight keys — clearing
 * every environment's latch would release a sibling environment's pending create and let a new
 * subscription for it seed a duplicate, which is this very bug through another door.
 */
const inFlightWorktreesByEnvironment = new Map<string, Set<string>>()

export function isWebRuntimeInitialTerminalBootstrapInFlight(
  environmentId: string,
  worktreeId: string
): boolean {
  return inFlightWorktreesByEnvironment.get(environmentId)?.has(worktreeId) ?? false
}

/** Claims the bootstrap for this environment's worktree; false when another closure already holds it. */
export function beginWebRuntimeInitialTerminalBootstrap(
  environmentId: string,
  worktreeId: string
): boolean {
  const worktrees = inFlightWorktreesByEnvironment.get(environmentId)
  if (worktrees?.has(worktreeId)) {
    return false
  }
  if (worktrees) {
    worktrees.add(worktreeId)
  } else {
    inFlightWorktreesByEnvironment.set(environmentId, new Set([worktreeId]))
  }
  return true
}

export function endWebRuntimeInitialTerminalBootstrap(
  environmentId: string,
  worktreeId: string
): void {
  const worktrees = inFlightWorktreesByEnvironment.get(environmentId)
  if (!worktrees) {
    return
  }
  worktrees.delete(worktreeId)
  if (worktrees.size === 0) {
    inFlightWorktreesByEnvironment.delete(environmentId)
  }
}

export function clearWebRuntimeInitialTerminalBootstrapsForEnvironment(
  environmentId: string
): void {
  inFlightWorktreesByEnvironment.delete(environmentId)
}

export function clearAllWebRuntimeInitialTerminalBootstraps(): void {
  inFlightWorktreesByEnvironment.clear()
}

export function resetWebRuntimeInitialTerminalBootstrapForTests(): void {
  clearAllWebRuntimeInitialTerminalBootstraps()
}
