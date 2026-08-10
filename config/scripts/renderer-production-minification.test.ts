import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { originalPositionFor, sourceContentFor, TraceMap } from '@jridgewell/trace-mapping'
import { afterEach, describe, expect, it } from 'vitest'
import { build, type Plugin } from 'vite'
import {
  createRendererSourceMapCompactionPlugin,
  createRendererSourceMapProvenancePlugin,
  rendererProductionBuild,
  rendererProductionOutput,
  type RendererSourceMapMode
} from '../build-plugins/renderer-production-minification'
import { verifyLocalRendererSourceMaps } from './renderer-source-map-contract.cjs'

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

function createWorkerCollisionFixture(): string {
  const fixtureParent = resolve('out', 'test-fixtures')
  mkdirSync(fixtureParent, { recursive: true })
  const root = mkdtempSync(join(fixtureParent, 'renderer-worker-minification-'))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'index.html'),
    '<script type="module" src="/src/main.ts"></script>',
    'utf8'
  )
  writeFileSync(
    join(root, 'src', 'main.ts'),
    "new Worker(new URL('./worker-collision.ts', import.meta.url), { type: 'module' })\n",
    'utf8'
  )
  writeFileSync(
    join(root, 'src', 'worker-collision.ts'),
    [
      "import { Same as AlphaClass, same as alphaFunction } from './worker-alpha'",
      "import { Same as BetaClass, same as betaFunction } from './worker-beta'",
      'console.log(`worker-collision:${[alphaFunction.name, betaFunction.name, AlphaClass.name, BetaClass.name].join(",")}`)'
    ].join('\n'),
    'utf8'
  )
  for (const moduleName of ['worker-alpha', 'worker-beta']) {
    writeFileSync(
      join(root, 'src', `${moduleName}.ts`),
      'export function same(): void {}\nexport class Same {}\n',
      'utf8'
    )
  }
  return root
}

function createGeneratedDataFixture(): string {
  const fixtureParent = resolve('out', 'test-fixtures')
  mkdirSync(fixtureParent, { recursive: true })
  const root = mkdtempSync(join(fixtureParent, 'renderer-generated-data-'))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'index.html'),
    '<script type="module" src="/src/main.ts"></script>',
    'utf8'
  )
  writeFileSync(join(root, 'src', 'main.ts'), "void import('./strings.json')\n", 'utf8')
  writeFileSync(join(root, 'src', 'strings.json'), '{"message":"diagnostic text"}\n', 'utf8')
  return root
}

function createJavascriptAssetFixture(assetImport: string): string {
  const fixtureParent = resolve('out', 'test-fixtures')
  mkdirSync(fixtureParent, { recursive: true })
  const root = mkdtempSync(join(fixtureParent, 'renderer-javascript-asset-'))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(
    join(root, 'index.html'),
    '<script type="module" src="/src/main.ts"></script>',
    'utf8'
  )
  writeFileSync(
    join(root, 'src', 'main.ts'),
    `import assetUrl from ${JSON.stringify(assetImport)}\nvoid import(/* @vite-ignore */ assetUrl)\n`,
    'utf8'
  )
  return root
}

function createFacadeFixture(): string {
  const fixtureParent = resolve('out', 'test-fixtures')
  mkdirSync(fixtureParent, { recursive: true })
  const root = mkdtempSync(join(fixtureParent, 'renderer-facade-'))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  for (const entry of ['first', 'second']) {
    writeFileSync(
      join(root, 'src', `${entry}.ts`),
      "export { facadeValue } from './facade-implementation'\n",
      'utf8'
    )
  }
  writeFileSync(
    join(root, 'src', 'facade-implementation.ts'),
    'export function facadeValue(): string { return "facade" }\n',
    'utf8'
  )
  return root
}

function readProvenanceChunks(
  outputDir: string
): { file: string; sourceMap: RendererSourceMapMode }[] {
  return readdirSync(join(outputDir, 'source-map-provenance')).flatMap((fileName) => {
    const provenance = JSON.parse(
      readFileSync(join(outputDir, 'source-map-provenance', fileName), 'utf8')
    ) as {
      chunks: { file: string; sourceMap: RendererSourceMapMode }[]
    }
    return provenance.chunks
  })
}

function stripOrdinaryChunkMap(): Plugin {
  return {
    name: 'strip-ordinary-chunk-map',
    generateBundle: (_options, bundle) => {
      for (const output of Object.values(bundle)) {
        if (
          output.type === 'chunk' &&
          Object.keys(output.modules).some((id) => id.endsWith('probe.ts'))
        ) {
          output.map = null
          delete bundle[`${output.fileName}.map`]
        }
      }
    }
  }
}

function appendExecutableFacadeCode(): Plugin {
  return {
    name: 'append-executable-facade-code',
    generateBundle: (_options, bundle) => {
      const facade = Object.values(bundle).find(
        (output) =>
          output.type === 'chunk' &&
          output.code.length > 0 &&
          Object.keys(output.modules).length > 0 &&
          Object.values(output.modules).every((module) => module.renderedLength === 0)
      )
      if (!facade || facade.type !== 'chunk') {
        return
      }
      facade.code +=
        ';function injectedFirstPartyFacadeCrash(){throw new Error("injected-facade-crash")}injectedFirstPartyFacadeCrash();'
      facade.map = null
    }
  }
}

function facadeBuild(root: string, plugins: Plugin[]): Parameters<typeof build>[0] {
  return {
    root,
    configFile: false,
    logLevel: 'silent',
    plugins,
    build: {
      ...rendererProductionBuild,
      outDir: 'out',
      emptyOutDir: true,
      modulePreload: false,
      rollupOptions: {
        preserveEntrySignatures: 'strict',
        input: {
          first: join(root, 'src', 'first.ts'),
          second: join(root, 'src', 'second.ts')
        },
        output: rendererProductionOutput
      }
    }
  }
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
      plugins: [
        createRendererSourceMapProvenancePlugin(),
        createRendererSourceMapCompactionPlugin()
      ],
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
    expect(frame, execution.stderr).not.toBeNull()
    expect(() => readFileSync(`${outputPath}.map`)).toThrow()
    const mapContents = gunzipSync(readFileSync(`${outputPath}.map.gz`)).toString('utf8')
    const sourceMap = JSON.parse(mapContents) as {
      sources: string[]
      sourcesContent: (string | null)[]
    }
    expect(sourceMap.sources.every((source) => !isAbsolute(source))).toBe(true)
    expect(sourceMap.sourcesContent).toHaveLength(sourceMap.sources.length)
    expect(readProvenanceChunks(join(root, outDir))).toContainEqual({
      file: `assets/${outputFile}`,
      sourceMap: 'mapped'
    })
    const map = new TraceMap(mapContents)
    const original = originalPositionFor(map, {
      line: Number(frame![1]),
      column: Number(frame![2]) - 1
    })
    expect(original.source).toMatch(/src\/probe\.ts$/)
    expect(original.line).toBe(7)
    expect(sourceContentFor(map, original.source!)).toContain(
      'throw new TypeError(`renderer-minification-probe:'
    )
  })

  it('keeps collided function and class names inside a real worker bundle', async () => {
    const root = createWorkerCollisionFixture()
    const outDir = 'out'
    await build({
      root,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        createRendererSourceMapProvenancePlugin(),
        createRendererSourceMapCompactionPlugin()
      ],
      worker: {
        format: 'es',
        plugins: () => [createRendererSourceMapProvenancePlugin()],
        rollupOptions: { output: rendererProductionOutput }
      },
      build: {
        ...rendererProductionBuild,
        outDir,
        emptyOutDir: true,
        modulePreload: false,
        rollupOptions: { output: rendererProductionOutput }
      }
    })

    const assetsDir = join(root, outDir, 'assets')
    const workerFile = readdirSync(assetsDir).find((fileName) => {
      if (!fileName.endsWith('.js')) {
        return false
      }
      return readFileSync(join(assetsDir, fileName), 'utf8').includes('worker-collision:')
    })
    expect(workerFile).toBeDefined()
    const workerSource = readFileSync(join(assetsDir, workerFile!), 'utf8')
    const workerUrl = `data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`
    const execution = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `import(${JSON.stringify(workerUrl)})`],
      { encoding: 'utf8' }
    )
    expect(execution.status, execution.stderr).toBe(0)
    expect(execution.stdout).toContain('worker-collision:same,same,Same,Same')

    const workerMap = JSON.parse(
      gunzipSync(readFileSync(join(assetsDir, `${workerFile}.map.gz`))).toString('utf8')
    ) as { sources: string[]; sourcesContent: (string | null)[] }
    const workerSourceIndex = workerMap.sources.findIndex((source) =>
      source.endsWith('src/worker-collision.ts')
    )
    expect(workerSourceIndex).toBeGreaterThanOrEqual(0)
    expect(workerMap.sourcesContent).toHaveLength(workerMap.sources.length)
    expect(workerMap.sourcesContent[workerSourceIndex]).toContain('worker-collision:')
    expect(readProvenanceChunks(join(root, outDir))).toContainEqual({
      file: `assets/${workerFile}`,
      sourceMap: 'mapped'
    })
  })

  it('replaces a mappingless JSON map with an exact identity map', async () => {
    const root = createGeneratedDataFixture()
    const outDir = 'out'
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
        outDir,
        emptyOutDir: true,
        modulePreload: false,
        rollupOptions: { output: rendererProductionOutput }
      }
    })

    const identityChunk = readProvenanceChunks(join(root, outDir)).find(
      (chunk) => chunk.sourceMap === 'identity-generated'
    )
    expect(identityChunk).toBeDefined()
    const javascript = readFileSync(join(root, outDir, identityChunk!.file), 'utf8')
    const sourceMap = JSON.parse(
      gunzipSync(readFileSync(join(root, outDir, `${identityChunk!.file}.map.gz`))).toString('utf8')
    ) as { mappings: string; sources: string[]; sourcesContent: string[] }
    expect(sourceMap.mappings).not.toBe('')
    expect(sourceMap.sources).toEqual([
      `source-map-identity/${identityChunk!.file.split('/').at(-1)}`
    ])
    expect(sourceMap.sourcesContent).toEqual([javascript])
    expect(() => verifyLocalRendererSourceMaps('renderer', join(root, outDir))).not.toThrow()
  })

  it('requires a map when another plugin strips one from an ordinary chunk', async () => {
    const root = createFixture()
    const outDir = 'out'
    await expect(
      build({
        root,
        configFile: false,
        logLevel: 'silent',
        plugins: [
          stripOrdinaryChunkMap(),
          createRendererSourceMapProvenancePlugin(),
          createRendererSourceMapCompactionPlugin()
        ],
        build: {
          ...rendererProductionBuild,
          outDir,
          emptyOutDir: true,
          modulePreload: false,
          rollupOptions: { output: rendererProductionOutput }
        }
      })
    ).rejects.toThrow(/Missing compressed source map for assets\/index-[^/]+\.js/)
  })

  it.each(['js', 'cjs'])(
    'rejects a dynamically imported first-party .%s OutputAsset without a map',
    async (extension) => {
      const root = createJavascriptAssetFixture(`./lazy-first-party.${extension}?url`)
      writeFileSync(
        join(root, 'src', `lazy-first-party.${extension}`),
        'export function firstPartyLazyModule() { return "first-party" }\n',
        'utf8'
      )

      await expect(
        build({
          root,
          configFile: false,
          logLevel: 'silent',
          plugins: [
            createRendererSourceMapProvenancePlugin(),
            createRendererSourceMapCompactionPlugin()
          ],
          build: {
            ...rendererProductionBuild,
            assetsInlineLimit: 0,
            outDir: 'out',
            emptyOutDir: true,
            modulePreload: false,
            rollupOptions: { output: rendererProductionOutput }
          }
        })
      ).rejects.toThrow(
        new RegExp(`Missing compressed source map for assets/lazy-first-party-[^/]+\\.${extension}`)
      )
    }
  )

  it('gives the metadata-verified prebuilt PDF worker an exact identity map', async () => {
    const root = createJavascriptAssetFixture('pdfjs-dist/build/pdf.worker.min.mjs?url')
    const outDir = 'out'
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
        assetsInlineLimit: 0,
        outDir,
        emptyOutDir: true,
        modulePreload: false,
        rollupOptions: { output: rendererProductionOutput }
      }
    })

    const pdfWorker = readProvenanceChunks(join(root, outDir)).find(
      (chunk) => chunk.sourceMap === 'identity-generated' && chunk.file.endsWith('.mjs')
    )
    expect(pdfWorker?.file).toMatch(/assets\/pdf\.worker\.min-[^/]+\.mjs$/)
    const javascript = readFileSync(join(root, outDir, pdfWorker!.file), 'utf8')
    const sourceMap = JSON.parse(
      gunzipSync(readFileSync(join(root, outDir, `${pdfWorker!.file}.map.gz`))).toString('utf8')
    ) as { sourcesContent: string[] }
    expect(sourceMap.sourcesContent).toEqual([javascript])
    expect(() => verifyLocalRendererSourceMaps('renderer', join(root, outDir))).not.toThrow()
  })

  it('gives a physical-module facade an exact identity map', async () => {
    const root = createFacadeFixture()
    await build(
      facadeBuild(root, [
        createRendererSourceMapProvenancePlugin(),
        createRendererSourceMapCompactionPlugin()
      ])
    )

    const facade = readProvenanceChunks(join(root, 'out')).find(
      (chunk) => chunk.sourceMap === 'identity-generated'
    )
    expect(facade).toBeDefined()
    const facadeCode = readFileSync(join(root, 'out', facade!.file), 'utf8')
    expect(facadeCode).toMatch(/^(?:import|export)/)
    expect(() => verifyLocalRendererSourceMaps('renderer', join(root, 'out'))).not.toThrow()
  })

  it('identity-maps executable code appended to a physical-module facade', async () => {
    const root = createFacadeFixture()
    await build(
      facadeBuild(root, [
        appendExecutableFacadeCode(),
        createRendererSourceMapProvenancePlugin(),
        createRendererSourceMapCompactionPlugin()
      ])
    )

    const assetsDir = join(root, 'out', 'assets')
    const mutatedFacade = readdirSync(assetsDir).find((fileName) =>
      readFileSync(join(assetsDir, fileName), 'utf8').includes('injected-facade-crash')
    )
    expect(mutatedFacade).toBeDefined()
    const moduleUrl = pathToFileURL(join(assetsDir, mutatedFacade!)).href
    const execution = spawnSync(
      process.execPath,
      ['--input-type=module', '--eval', `import(${JSON.stringify(moduleUrl)})`],
      { encoding: 'utf8' }
    )
    expect(execution.status).not.toBe(0)
    expect(execution.stderr).toContain('injected-facade-crash')
    const escapedFileName = mutatedFacade!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const frame = execution.stderr.match(new RegExp(`${escapedFileName}:(\\d+):(\\d+)`))
    expect(frame, execution.stderr).not.toBeNull()
    expect(() => verifyLocalRendererSourceMaps('renderer', join(root, 'out'))).not.toThrow()
    const javascript = readFileSync(join(assetsDir, mutatedFacade!), 'utf8')
    const mapContents = gunzipSync(
      readFileSync(join(assetsDir, `${mutatedFacade}.map.gz`))
    ).toString('utf8')
    const sourceMap = JSON.parse(mapContents) as { sourcesContent: string[] }
    const original = originalPositionFor(new TraceMap(mapContents), {
      line: Number(frame![1]),
      column: Number(frame![2]) - 1
    })
    expect(original).toMatchObject({
      source: `source-map-identity/${mutatedFacade}`,
      line: Number(frame![1]),
      column: Number(frame![2]) - 1
    })
    expect(sourceMap.sourcesContent).toEqual([javascript])
  })
})
