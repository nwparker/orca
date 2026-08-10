import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { originalPositionFor, TraceMap } from '@jridgewell/trace-mapping'
import { afterEach, describe, expect, it } from 'vitest'
import { build } from 'vite'
import {
  createRendererSourceMapCompactionPlugin,
  rendererProductionBuild,
  rendererProductionOutput
} from '../build-plugins/renderer-production-minification'

const temporaryRoots: string[] = []

function createFixture(): string {
  const fixtureParent = resolve('out', 'test-fixtures')
  mkdirSync(fixtureParent, { recursive: true })
  const root = mkdtempSync(join(fixtureParent, 'renderer-minification-'))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'index.html'),
    '<script type="module" src="/src/probe.ts"></script>',
    'utf8'
  )
  writeFileSync(
    join(root, 'src', 'probe.ts'),
    [
      "import { Same as AlphaClass, same as alphaFunction } from './probe-alpha'",
      "import { Same as BetaClass, same as betaFunction } from './probe-beta'",
      'const rendererMinificationDiagnosticPadding = "padding-padding-padding-padding"',
      'function deliberateRendererCrash(): never {',
      '  const descriptiveRendererState = rendererMinificationDiagnosticPadding.length',
      '  const collisionNames = [alphaFunction.name, betaFunction.name, AlphaClass.name, BetaClass.name].join(",")',
      '  throw new TypeError(`renderer-minification-probe:${descriptiveRendererState}:${collisionNames}`)',
      '}',
      'deliberateRendererCrash()'
    ].join('\n'),
    'utf8'
  )
  for (const moduleName of ['probe-alpha', 'probe-beta']) {
    writeFileSync(
      join(root, 'src', `${moduleName}.ts`),
      'export function same(): void {}\nexport class Same {}\n',
      'utf8'
    )
  }
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('renderer production minification', () => {
  it('keeps crash names and emits an adjacent map that resolves the thrown frame', async () => {
    const root = createFixture()
    const outDir = 'out'
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [createRendererSourceMapCompactionPlugin()],
      build: {
        ...rendererProductionBuild,
        outDir,
        emptyOutDir: true,
        modulePreload: false,
        rollupOptions: { output: rendererProductionOutput }
      }
    })

    const assetsDir = join(root, outDir, 'assets')
    const outputFile = readdirSync(assetsDir).find((fileName) => fileName.endsWith('.js'))
    expect(outputFile).toBeDefined()
    const outputPath = join(assetsDir, outputFile!)
    const output = readFileSync(outputPath, 'utf8')
    expect(output).not.toContain('rendererMinificationDiagnosticPadding')
    expect(output).not.toContain('descriptiveRendererState')
    expect(output).not.toContain('sourceMappingURL')

    const execution = spawnSync(process.execPath, [outputPath], { encoding: 'utf8' })
    expect(execution.status).not.toBe(0)
    expect(execution.stderr).toContain(
      'TypeError: renderer-minification-probe:31:same,same,Same,Same'
    )
    expect(execution.stderr).toContain('deliberateRendererCrash')

    const escapedOutputFile = outputFile!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const frame = execution.stderr.match(new RegExp(`${escapedOutputFile}:(\\d+):(\\d+)`))
    expect(frame).not.toBeNull()
    expect(() => readFileSync(`${outputPath}.map`)).toThrow()
    const mapContents = gunzipSync(readFileSync(`${outputPath}.map.gz`)).toString('utf8')
    expect(JSON.parse(mapContents)).not.toHaveProperty('sourcesContent')
    const map = new TraceMap(mapContents)
    const original = originalPositionFor(map, {
      line: Number(frame![1]),
      column: Number(frame![2]) - 1
    })
    expect(original.source).toMatch(/src\/probe\.ts$/)
    expect(original.line).toBe(7)
  })
})
