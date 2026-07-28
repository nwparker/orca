export const ORCHESTRATION_DISPATCH_READY_TIMEOUT_MS = 60_000

export function isInjectedOrchestrationDispatch(method: string, params: unknown): boolean {
  if (method !== 'orchestration.dispatch' || typeof params !== 'object' || params === null) {
    return false
  }
  const dispatch = params as { inject?: unknown; dryRun?: unknown }
  return dispatch.inject === true && dispatch.dryRun !== true
}
