import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { TuiAgent } from '../../shared/tui-agent'

/** Descendant sweeping is needed for launched agents and recognized foreground agents. */
export function hasAgentTeardownEvidence(
  launchAgent: TuiAgent | null | undefined,
  subprocess: { getForegroundProcess(): string | null }
): boolean {
  return Boolean(launchAgent) || recognizeAgentProcess(subprocess.getForegroundProcess()) !== null
}
