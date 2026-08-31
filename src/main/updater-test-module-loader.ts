import { beforeAll, expect } from 'vitest'
import type * as UpdaterModule from './updater'
import { trackRealTimers } from './updater-test-timer-tracking'

/**
 * Pays `updater.ts`'s transform cost once per file, against `hookTimeout` instead of `testTimeout`.
 *
 * Why: the module is ~2.4k lines and pulls in a wide graph, so a worker's first import of it costs
 * ~1.4s idle but 45s+ on an oversubscribed machine — past the 30s `testTimeout`. `vi.resetModules()`
 * re-evaluates the module without re-transforming it, so only a file's *first* import is exposed;
 * warming it in a hook moves that one slow import onto the 60s hook budget and leaves every in-test
 * import at re-evaluation cost (~25ms idle).
 */
export function warmUpdaterModule(): void {
  beforeAll(async () => {
    // Why: no reset has installed the tracker yet, so a timer armed while warming would outlive it.
    trackRealTimers()
    await import('./updater')
  })
}

/**
 * Imports `./updater`, refusing to hand the module to a test that has already ended.
 *
 * Why: vitest cannot cancel a timed-out test body. When the import outran `testTimeout` the
 * continuation went on to call `setupAutoUpdater` during the *next* test, failing it with
 * "expected 1 times, but got 2 times" — the exact signature of the abandoned-instance timer flake
 * fixed in #17649/#17663, so the timeout read as that regression returning. Throwing here strands the
 * continuation and leaves the timeout as the only reported failure.
 */
export async function loadUpdaterModule(): Promise<typeof UpdaterModule> {
  const owner = expect.getState().currentTestName
  const module = await import('./updater')
  const current = expect.getState().currentTestName
  if (owner !== undefined && owner !== current) {
    throw new Error(
      `updater import requested by "${owner}" resolved after that test ended (now running ` +
        `"${String(current)}"). The test timed out mid-import; fix that timeout, not the assertions.`
    )
  }
  return module
}
