import { describe, expect, it } from 'vitest'
import { normalizeDeprecatedCodexHookFeatureFlag } from './config-toml-deprecated-hook-flag'

describe('normalizeDeprecatedCodexHookFeatureFlag', () => {
  it('normalizes an escaped quoted deprecated key', () => {
    const config = ['[features]', '"codex\\u005fhooks" = true', ''].join('\n')

    expect(normalizeDeprecatedCodexHookFeatureFlag(config)).toBe(
      ['[features]', 'hooks = true', ''].join('\n')
    )
  })

  it('ignores apparent feature structure inside multiline basic strings', () => {
    const config = [
      'instructions = """',
      '[features]',
      'hooks = false',
      'codex_hooks = false',
      '"""',
      '',
      '[features]',
      'description = """',
      'hooks = false',
      'codex_hooks = false',
      '"""',
      'codex_hooks = true',
      ''
    ].join('\n')

    expect(normalizeDeprecatedCodexHookFeatureFlag(config)).toBe(
      config.replace(/codex_hooks = true\n$/, 'hooks = true\n')
    )
  })

  it('ignores apparent feature structure inside multiline literal strings with CRLF', () => {
    const config = [
      "instructions = '''",
      '[features]',
      'hooks = false',
      'codex_hooks = false',
      "'''",
      '',
      '[features]',
      "description = '''",
      'hooks = false',
      'codex_hooks = false',
      "'''",
      'hooks = true',
      'codex_hooks = true',
      ''
    ].join('\r\n')

    expect(normalizeDeprecatedCodexHookFeatureFlag(config)).toBe(
      config.replace('hooks = true\r\ncodex_hooks = true\r\n', 'hooks = true\r\n')
    )
  })
})
