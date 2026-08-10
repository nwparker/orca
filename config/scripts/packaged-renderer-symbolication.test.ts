import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { originalPositionFor, sourceContentFor, TraceMap } from '@jridgewell/trace-mapping'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'vite'
import {
  createRendererSourceMapCompactionPlugin,
  createRendererSourceMapProvenancePlugin,
  rendererProductionBuild,
  rendererProductionOutput
} from '../build-plugins/renderer-production-minification'
import {
  normalizeAsarEntry,
  verifyPackagedRendererSourceMaps
} from './verify-packaged-renderer-source-maps.cjs'

const require = createRequire(import.meta.url)
const asar = require('@electron/asar') as {
  createPackage: (source: string, destination: string) => Promise<void>
  extractFile: (archive: string, entry: string) => Buffer
  listPackage: (archive: string) => string[]
}
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('packaged renderer symbolication', () => {
  it('resolves a minified exception and source line using only the ASAR map', async () => {
    const fixtureParent = resolve('out', 'test-fixtures')
    mkdirSync(fixtureParent, { recursive: true })
    const root = mkdtempSync(join(fixtureParent, 'packaged-symbolication-'))
    temporaryRoots.push(root)
    const sourcePath = join(root, 'src', 'packaged-crash.ts')
    mkdirSync(dirname(sourcePath), { recursive: true })
    writeFileSync(
      join(root, 'index.html'),
      '<script type="module" src="/src/packaged-crash.ts"></script>'
    )
    writeFileSync(
      sourcePath,
      [
        'const packagedDiagnosticValue = 42',
        'function deliberatePackagedCrash(): never {',
        '  const message = `packaged-symbolication:${packagedDiagnosticValue}`',
        '  throw new TypeError(message)',
        '}',
        'deliberatePackagedCrash()'
      ].join('\n')
    )

    const buildDir = join(root, 'build')
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        createRendererSourceMapProvenancePlugin(),
        createRendererSourceMapCompactionPlugin()
      ],
      build: {
        ...rendererProductionBuild,
        outDir: buildDir,
        emptyOutDir: true,
        modulePreload: false,
        rollupOptions: { output: rendererProductionOutput }
      }
    })

    const stagingDir = join(root, 'staging')
    cpSync(buildDir, join(stagingDir, 'out', 'renderer'), { recursive: true })
    cpSync(buildDir, join(stagingDir, 'out', 'web'), { recursive: true })
    const resourcesDir = join(root, 'resources')
    mkdirSync(resourcesDir)
    const archivePath = join(resourcesDir, 'app.asar')
    await asar.createPackage(stagingDir, archivePath)
    verifyPackagedRendererSourceMaps(resourcesDir, asar, {
      renderer: buildDir,
      web: join(stagingDir, 'out', 'web')
    })

    rmSync(sourcePath)
    rmSync(buildDir, { recursive: true })
    rmSync(stagingDir, { recursive: true })
    expect(existsSync(sourcePath)).toBe(false)

    const archiveEntries = asar.listPackage(archivePath)
    const javascriptEntry = archiveEntries.find((entry) => {
      const normalized = normalizeAsarEntry(entry)
      return normalized.startsWith('out/renderer/assets/') && normalized.endsWith('.js')
    })
    expect(javascriptEntry).toBeDefined()
    const normalizedJavaScriptEntry = normalizeAsarEntry(javascriptEntry!)
    const mapEntry = archiveEntries.find(
      (entry) => normalizeAsarEntry(entry) === `${normalizedJavaScriptEntry}.map.gz`
    )
    expect(mapEntry).toBeDefined()

    const extractedJavaScriptPath = join(root, basename(normalizedJavaScriptEntry))
    writeFileSync(
      extractedJavaScriptPath,
      asar.extractFile(archivePath, javascriptEntry!.replace(/^[\\/]+/, ''))
    )
    const execution = spawnSync(process.execPath, [extractedJavaScriptPath], { encoding: 'utf8' })
    expect(execution.status).not.toBe(0)
    expect(execution.stderr).toContain('TypeError: packaged-symbolication:42')
    expect(execution.stderr).toContain('deliberatePackagedCrash')

    const escapedFileName = basename(extractedJavaScriptPath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const frame = execution.stderr.match(new RegExp(`${escapedFileName}:(\\d+):(\\d+)`))
    expect(frame).not.toBeNull()
    const mapBytes = asar.extractFile(archivePath, mapEntry!.replace(/^[\\/]+/, ''))
    const traceMap = new TraceMap(gunzipSync(mapBytes).toString('utf8'))
    const original = originalPositionFor(traceMap, {
      line: Number(frame![1]),
      column: Number(frame![2]) - 1
    })
    expect(original.source).toMatch(/src\/packaged-crash\.ts$/)
    expect(original.line).toBe(4)
    expect(sourceContentFor(traceMap, original.source!)).toContain('throw new TypeError(message)')
  })
})
