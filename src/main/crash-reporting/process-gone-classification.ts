export type ProcessGoneSource = 'renderer' | 'child'
export type ExpectedTeardownScope = 'none' | 'renderer-reload' | 'app-shutdown'

const WINDOWS_CONTROL_TERMINATION_EXIT_CODES = new Set([0xc000013a, 0x40010004])
const NON_FATAL_CHILD_PROCESS_TYPES = new Set(['GPU'])
const NON_FATAL_UTILITY_SERVICE_NAMES = new Set(['network.mojom.NetworkService'])

function isWindowsControlTerminationExitCode(exitCode: number | null): boolean {
  if (exitCode === null) {
    return false
  }
  return WINDOWS_CONTROL_TERMINATION_EXIT_CODES.has(exitCode >>> 0)
}

function isNonFatalChromiumChildProcess({
  source,
  processType,
  serviceName
}: {
  source: ProcessGoneSource
  processType?: string
  serviceName?: string
}): boolean {
  if (source !== 'child') {
    return false
  }
  if (processType && NON_FATAL_CHILD_PROCESS_TYPES.has(processType)) {
    return true
  }
  return (
    processType === 'Utility' &&
    serviceName !== undefined &&
    NON_FATAL_UTILITY_SERVICE_NAMES.has(serviceName)
  )
}

export function shouldRecordProcessGoneCrash({
  source,
  processType,
  serviceName,
  reason,
  exitCode,
  expectedTeardown
}: {
  source: ProcessGoneSource
  processType?: string
  serviceName?: string
  reason: string
  exitCode: number | null
  expectedTeardown: ExpectedTeardownScope
}): boolean {
  // Why: GPU and Chromium Network Service exits are recoverable child-process
  // churn, not Orca renderer crashes. Recording them opens noisy crash prompts.
  if (isNonFatalChromiumChildProcess({ source, processType, serviceName })) {
    return false
  }
  // Why: Electron reports intentional reload/update/quit teardown as `killed`.
  // Real renderer OOMs and Chromium crashes should still reach crash reporting.
  if (reason !== 'killed') {
    return true
  }
  // Why: Electron reports expected Chromium teardown during reload/update as
  // `killed` + SIGTERM or Windows control termination statuses. Treat real
  // crash reasons as reportable, but skip these normal termination shapes.
  if (exitCode === 15 || isWindowsControlTerminationExitCode(exitCode)) {
    return false
  }
  if (expectedTeardown === 'app-shutdown') {
    return false
  }
  return !(source === 'renderer' && expectedTeardown === 'renderer-reload')
}

export function shouldRecoverRendererAfterProcessGone({
  reason,
  expectedTeardown
}: {
  reason: string
  expectedTeardown: ExpectedTeardownScope
}): boolean {
  if (expectedTeardown === 'app-shutdown') {
    return false
  }
  return !(reason === 'killed' && expectedTeardown === 'renderer-reload')
}
