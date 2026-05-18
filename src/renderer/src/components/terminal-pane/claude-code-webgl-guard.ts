const AFFECTED_CLAUDE_CODE_VERSION = [2, 1, 143] as const

let cachedLocalClaudeCodeWebglSuppressed: boolean | null = null
let pendingLocalClaudeCodeWebglSuppressed: Promise<boolean> | null = null

function parseSemverPrefix(output: string | null | undefined): [number, number, number] | null {
  const match = output?.match(/\b(\d+)\.(\d+)\.(\d+)\b/)
  if (!match) {
    return null
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function compareSemver(
  left: readonly [number, number, number],
  right: readonly [number, number, number]
): number {
  for (let i = 0; i < 3; i++) {
    const diff = left[i] - right[i]
    if (diff !== 0) {
      return diff
    }
  }
  return 0
}

export function isClaudeCodeVersionAffectedByWebglGlyphBug(
  versionOutput: string | null | undefined
): boolean {
  const version = parseSemverPrefix(versionOutput)
  return version !== null && compareSemver(version, AFFECTED_CLAUDE_CODE_VERSION) <= 0
}

export async function shouldSuppressWebglForLocalClaudeCode(): Promise<boolean> {
  if (cachedLocalClaudeCodeWebglSuppressed !== null) {
    return cachedLocalClaudeCodeWebglSuppressed
  }
  if (!pendingLocalClaudeCodeWebglSuppressed) {
    pendingLocalClaudeCodeWebglSuppressed = (async (): Promise<boolean> => {
      try {
        const version = await window.api.preflight.getAgentVersion({ agent: 'claude' })
        const shouldSuppress = isClaudeCodeVersionAffectedByWebglGlyphBug(version)
        cachedLocalClaudeCodeWebglSuppressed = shouldSuppress
        return shouldSuppress
      } catch {
        cachedLocalClaudeCodeWebglSuppressed = false
        return false
      } finally {
        pendingLocalClaudeCodeWebglSuppressed = null
      }
    })()
  }
  return pendingLocalClaudeCodeWebglSuppressed
}

export function resetClaudeCodeWebglGuardCacheForTests(): void {
  cachedLocalClaudeCodeWebglSuppressed = null
  pendingLocalClaudeCodeWebglSuppressed = null
}
