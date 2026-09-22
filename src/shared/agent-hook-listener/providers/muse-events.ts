import { isAskUserQuestionTool } from '../../agent-question-answered-intent'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../agent-status-types'
import type { HookListenerState } from '../listener-state'
import {
  resolvePrompt,
  resolveToolState,
  shouldIgnoreCompactContinuationUserPromptSubmit
} from '../prompt-fields'
import { extractToolFields, isNewTurnEvent } from '../provider-event-routing'
import { readString } from '../tool-input-preview'

// Muse uses Claude-compatible hook events but retains its own agent identity.
export function normalizeMuseEvent(
  state: HookListenerState,
  eventName: unknown,
  promptText: string,
  paneKey: string,
  hookPayload: Record<string, unknown>
): ParsedAgentStatusPayload | null {
  if (shouldIgnoreCompactContinuationUserPromptSubmit(eventName, promptText)) {
    return null
  }

  const toolName = readString(hookPayload, 'tool_name')
  const isUserInputTool = isAskUserQuestionTool(toolName)

  let stateName: 'working' | 'waiting' | 'done' | null = null
  if (
    eventName === 'UserPromptSubmit' ||
    eventName === 'PostToolUse' ||
    eventName === 'PostToolUseFailure' ||
    (eventName === 'PreToolUse' && !isUserInputTool)
  ) {
    stateName = 'working'
  } else if (eventName === 'PermissionRequest' || (eventName === 'PreToolUse' && isUserInputTool)) {
    stateName = 'waiting'
  } else if (eventName === 'Stop' || eventName === 'StopFailure') {
    stateName = 'done'
  }

  if (!stateName) {
    return null
  }

  const snapshot = resolveToolState(
    state,
    paneKey,
    extractToolFields('muse', eventName, hookPayload),
    { resetOnNewTurn: isNewTurnEvent('muse', eventName) }
  )

  const interrupted =
    eventName === 'Stop' && hookPayload['is_interrupt'] === true ? true : undefined

  return normalizeAgentStatusPayload({
    state: stateName,
    prompt: resolvePrompt(state, paneKey, promptText, {
      resetOnNewTurn: isNewTurnEvent('muse', eventName)
    }),
    agentType: 'muse',
    toolName: snapshot.toolName,
    toolInput: snapshot.toolInput,
    interactivePrompt: snapshot.interactivePrompt,
    lastAssistantMessage: snapshot.lastAssistantMessage,
    lastAssistantMessageIsToolOutput: snapshot.lastAssistantMessageIsToolOutput,
    interrupted
  })
}
