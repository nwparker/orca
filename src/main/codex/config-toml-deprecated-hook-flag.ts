import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'

export function normalizeDeprecatedCodexHookFeatureFlag(config: string): string {
  const lines = config.split('\n')
  const featureSections: { start: number; end: number }[] = []
  let featureStart: number | null = null
  let state = createTomlLineScanState()

  for (let index = 0; index <= lines.length; index += 1) {
    const line = lines[index]
    const header =
      line !== undefined && isTomlStructuralLine(state) ? getTomlTableHeader(line) : null
    if (line !== undefined && !header) {
      state = updateTomlLineScanState(state, line)
      continue
    }

    if (featureStart !== null) {
      featureSections.push({ start: featureStart, end: index })
      featureStart = null
    }
    const table = header ? parseTomlTableHeaderPath(header) : null
    if (
      table &&
      !table.isArray &&
      table.segments.length === 1 &&
      table.segments[0] === 'features'
    ) {
      featureStart = index
    }
    if (line !== undefined) {
      state = updateTomlLineScanState(state, line)
    }
  }

  for (const section of featureSections.toReversed()) {
    normalizeFeatureSectionLines(lines, section.start + 1, section.end)
  }
  return lines.join('\n')
}

function normalizeFeatureSectionLines(lines: string[], start: number, end: number): void {
  const deprecatedIndexes: number[] = []
  let hasHooksKey = false
  let state = createTomlLineScanState()
  for (let index = start; index < end; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(state)) {
      const parsed = parseTomlKeyPath(line)
      const key = parsed?.segments.length === 1 ? parsed.segments[0] : null
      if (parsed && line[parsed.end] === '=') {
        if (key === 'hooks') {
          hasHooksKey = true
        }
        if (key === 'codex_hooks') {
          deprecatedIndexes.push(index)
        }
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  if (deprecatedIndexes.length === 0) {
    return
  }

  if (!hasHooksKey) {
    const firstDeprecatedIndex = deprecatedIndexes.shift()
    if (firstDeprecatedIndex !== undefined) {
      // Why: Codex 0.133 warns on the old key. Mirror into Orca's runtime
      // config using the new key without rewriting the user's real config.
      lines[firstDeprecatedIndex] = renameDeprecatedHookKey(lines[firstDeprecatedIndex] ?? '')
    }
  }

  for (const index of deprecatedIndexes.toReversed()) {
    lines.splice(index, 1)
  }
}

function renameDeprecatedHookKey(line: string): string {
  const parsed = parseTomlKeyPath(line)
  if (!parsed || parsed.segments.length !== 1 || parsed.segments[0] !== 'codex_hooks') {
    return line
  }
  const keyStart = /^[ \t]*/.exec(line)?.[0].length ?? 0
  let keyEnd = parsed.end
  while (line[keyEnd - 1] === ' ' || line[keyEnd - 1] === '\t') {
    keyEnd -= 1
  }
  return `${line.slice(0, keyStart)}hooks${line.slice(keyEnd)}`
}
