import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fsMock = vi.hoisted(() => ({ renameSync: vi.fn() }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  fsMock.renameSync.mockImplementation(actual.renameSync)
  return { ...actual, renameSync: fsMock.renameSync }
})

import { writeCodexSettingsBaseline } from './config-settings-baseline'

let runtimeHomePath: string | undefined

afterEach(() => {
  if (runtimeHomePath) {
    rmSync(runtimeHomePath, { recursive: true, force: true })
    runtimeHomePath = undefined
  }
  vi.clearAllMocks()
})

describe('writeCodexSettingsBaseline', () => {
  it('preserves the previous baseline when atomic replacement fails', () => {
    runtimeHomePath = mkdtempSync(join(tmpdir(), 'orca-codex-settings-baseline-'))
    const baselinePath = join(runtimeHomePath, '.orca-config-settings-baseline.json')
    writeCodexSettingsBaseline(runtimeHomePath, {
      settings: new Map([['model', '"previous"']]),
      conflicts: new Map()
    })
    const previous = readFileSync(baselinePath, 'utf-8')
    fsMock.renameSync.mockImplementationOnce(() => {
      throw Object.assign(new Error('injected replacement failure'), { code: 'EIO' })
    })

    expect(() =>
      writeCodexSettingsBaseline(runtimeHomePath!, {
        settings: new Map([['model', '"next"']]),
        conflicts: new Map()
      })
    ).toThrow('injected replacement failure')
    expect(readFileSync(baselinePath, 'utf-8')).toBe(previous)
    expect(readdirSync(runtimeHomePath).filter((name) => name.endsWith('.tmp'))).toEqual([])
  })
})
