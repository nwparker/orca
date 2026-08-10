export const COMPUTER_AWAKE_MODES = ['on', 'off', 'auto'] as const

export type ComputerAwakeMode = (typeof COMPUTER_AWAKE_MODES)[number]

export type ComputerAwakeStatus = {
  mode: ComputerAwakeMode
  active: boolean
  workingAgentCount: number
}

export function normalizeComputerAwakeMode(
  mode: unknown,
  legacyAutoEnabled = false
): ComputerAwakeMode {
  return COMPUTER_AWAKE_MODES.includes(mode as ComputerAwakeMode)
    ? (mode as ComputerAwakeMode)
    : legacyAutoEnabled
      ? 'auto'
      : 'off'
}

export function computerAwakeSettingsForMode(mode: ComputerAwakeMode): {
  computerAwakeMode: ComputerAwakeMode
  keepComputerAwakeWhileAgentsRun: boolean
} {
  return {
    computerAwakeMode: mode,
    // Older Orca versions approximate On with their supported Auto behavior.
    keepComputerAwakeWhileAgentsRun: mode !== 'off'
  }
}
