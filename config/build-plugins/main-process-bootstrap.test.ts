import { EventEmitter } from 'node:events'
import { posix } from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import {
  MAIN_PROCESS_BOOTSTRAP_FILE,
  MAIN_PROCESS_COMPILE_CACHE_DIRECTORY,
  createMainProcessBootstrap
} from './main-process-bootstrap'
import { BOOTSTRAP_FATAL_EXIT_GUARD_KEY } from '../../src/main/startup/bootstrap-fatal-exit-guard'

function runBootstrap(options: {
  compileCacheSupported?: boolean
  enableCompileCache?: (directory: string) => unknown
  flushCompileCache?: () => void
  getUserDataPath?: () => string
  isPackaged?: boolean
  loadMain?: () => unknown
  nodeCompileCache?: string
  startupDiagnostics?: '1' | 'trace'
}): { exports: unknown; timeline: string[] } {
  const timeline: string[] = []
  const processMock = new EventEmitter() as EventEmitter & {
    argv: string[]
    env: Record<string, string>
    execPath: string
    exit: (code: number) => void
    exitCode?: number
    pid: number
    ppid: number
  }
  processMock.argv = []
  processMock.env = {
    ...(options.nodeCompileCache ? { NODE_COMPILE_CACHE: options.nodeCompileCache } : {}),
    ...(options.startupDiagnostics ? { ORCA_STARTUP_DIAGNOSTICS: options.startupDiagnostics } : {})
  }
  processMock.execPath = '/electron'
  processMock.exit = () => {}
  processMock.pid = 42
  processMock.ppid = 7
  const moduleMock = { exports: undefined as unknown }
  const compileCacheModule =
    options.compileCacheSupported === false
      ? {}
      : {
          enableCompileCache: (directory: string) => {
            timeline.push(`enable:${directory}`)
            return options.enableCompileCache?.(directory)
          },
          flushCompileCache: () => {
            timeline.push('flush')
            options.flushCompileCache?.()
          }
        }
  const requireMock = (specifier: string): unknown => {
    if (specifier === 'node:module') {
      return compileCacheModule
    }
    if (specifier === 'node:path') {
      return posix
    }
    if (specifier === 'node:fs') {
      return {
        writeSync: (_descriptor: number, message: string) => {
          timeline.push(`diagnostic:${message.trim()}`)
        }
      }
    }
    if (specifier === 'electron') {
      return {
        app: {
          getPath: options.getUserDataPath ?? (() => '/user-data'),
          isPackaged: options.isPackaged ?? true
        }
      }
    }
    if (specifier === './index.js') {
      timeline.push('main')
      return options.loadMain?.() ?? { loaded: true }
    }
    throw new Error(`Unexpected require: ${specifier}`)
  }

  runInNewContext(createMainProcessBootstrap(), {
    globalThis: {},
    module: moduleMock,
    process: processMock,
    require: requireMock,
    setImmediate: () => {},
    setTimeout: (callback: () => void) => {
      callback()
      return { unref: () => {} }
    }
  })
  return { exports: moduleMock.exports, timeline }
}

describe('main-process bootstrap', () => {
  it('installs fatal and diagnostic guards before cache setup and the real bundle', () => {
    const source = createMainProcessBootstrap()

    expect(source.indexOf(BOOTSTRAP_FATAL_EXIT_GUARD_KEY)).toBeLessThan(
      source.indexOf('ORCA_STARTUP_DIAGNOSTICS')
    )
    expect(source.indexOf('ORCA_STARTUP_DIAGNOSTICS')).toBeLessThan(
      source.indexOf('enableCompileCache')
    )
    expect(source.indexOf('enableCompileCache')).toBeLessThan(source.indexOf('./index.js'))
    expect(MAIN_PROCESS_BOOTSTRAP_FILE).toBe('bootstrap.cjs')
  })

  it('enables and flushes the compile cache around the real main bundle', () => {
    const result = runBootstrap({})

    expect(result.timeline).toEqual([
      `enable:/user-data/${MAIN_PROCESS_COMPILE_CACHE_DIRECTORY}`,
      'main',
      'flush'
    ])
    expect(result.exports).toEqual({ loaded: true })
  })

  it('preserves startup diagnostics before cache setup', () => {
    const result = runBootstrap({ startupDiagnostics: '1' })

    expect(result.timeline[0]).toContain('diagnostic:[bootstrap] bundle-enter chunk="index.js"')
    expect(result.timeline[1]).toBe(`enable:/user-data/${MAIN_PROCESS_COMPILE_CACHE_DIRECTORY}`)
  })

  it('respects Node compile-cache directory configuration', () => {
    const result = runBootstrap({ nodeCompileCache: '/configured-cache' })

    expect(result.timeline[0]).toBe('enable:/configured-cache')
  })

  it('keeps development caches out of the packaged profile', () => {
    const result = runBootstrap({
      getUserDataPath: (name?: string) =>
        name === 'appData' ? '/app-data' : '/packaged-user-data',
      isPackaged: false
    })

    expect(result.timeline[0]).toBe(
      `enable:/app-data/orca-dev/${MAIN_PROCESS_COMPILE_CACHE_DIRECTORY}`
    )
  })

  it('launches when the cache directory is read-only', () => {
    const result = runBootstrap({
      enableCompileCache: () => ({ status: 0, message: 'permission denied' })
    })

    expect(result.timeline).toContain('main')
    expect(result.exports).toEqual({ loaded: true })
  })

  it('launches when cache-directory resolution is unavailable', () => {
    const result = runBootstrap({
      getUserDataPath: () => {
        throw new Error('userData unavailable')
      }
    })

    expect(result.timeline).toEqual(['main', 'flush'])
    expect(result.exports).toEqual({ loaded: true })
  })

  it('launches when the compile-cache API is unavailable', () => {
    const result = runBootstrap({ compileCacheSupported: false })

    expect(result.timeline).toEqual(['main'])
    expect(result.exports).toEqual({ loaded: true })
  })

  it('does not hide a real-main failure behind cache persistence', () => {
    const flushCompileCache = vi.fn()

    expect(() =>
      runBootstrap({
        flushCompileCache,
        loadMain: () => {
          throw new Error('main failed')
        }
      })
    ).toThrow('main failed')
    expect(flushCompileCache).not.toHaveBeenCalled()
  })
})
