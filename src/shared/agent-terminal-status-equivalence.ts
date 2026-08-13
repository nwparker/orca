import type { ParsedAgentStatusPayload } from './agent-status-types'

/** Whether a terminal status is the same hook status with only hook-owned metadata omitted. */
export function terminalStatusPayloadMatchesHook(
  cachedHookPayload: ParsedAgentStatusPayload,
  terminalPayload: ParsedAgentStatusPayload
): boolean {
  // OSC never carries model/children; compare only fields its protocol owns.
  return (
    cachedHookPayload.state === terminalPayload.state &&
    (terminalPayload.workingMode === undefined ||
      cachedHookPayload.workingMode === terminalPayload.workingMode) &&
    cachedHookPayload.prompt === terminalPayload.prompt &&
    cachedHookPayload.agentType === terminalPayload.agentType &&
    cachedHookPayload.toolName === terminalPayload.toolName &&
    cachedHookPayload.toolInput === terminalPayload.toolInput &&
    cachedHookPayload.interactivePrompt === terminalPayload.interactivePrompt &&
    cachedHookPayload.lastAssistantMessage === terminalPayload.lastAssistantMessage &&
    cachedHookPayload.interrupted === terminalPayload.interrupted &&
    // A session-boundary done must never dedupe against a real done (STA-3386).
    cachedHookPayload.sessionBoundary === terminalPayload.sessionBoundary
  )
}
