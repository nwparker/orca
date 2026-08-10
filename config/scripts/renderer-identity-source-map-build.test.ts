import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { build, type Plugin } from 'vite'
import {
  createRendererSourceMapCompactionPlugin,
  createRendererSourceMapProvenancePlugin,
  rendererProductionBuild,
  rendererProductionOutput
} from '../build-plugins/renderer-production-minification'
import { verifyLocalRendererSourceMaps } from './renderer-source-map-contract.cjs'

const temporaryRoots: string[] = []

function createFixture(mainSource: string): string {
  const parent = resolve('out', 'test-fixtures')
  mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'renderer-identity-map-'))
  temporaryRoots.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n')
  writeFileSync(join(root, 'index.html'), '<script type="module" src="/src/main.ts"></script>')
  writeFileSync(join(root, 'src', 'main.ts'), mainSource)
  return root
}

function mutateChunk(moduleMatches: (moduleId: string) => boolean, appendedCode = ''): Plugin {
  return {
    name: 'mutate-identity-map-candidate',
    generateBundle: (_options, bundle) => {
      const chunk = Object.values(bundle).find(
        (output) =>
          output.type === 'chunk' &&
          Object.keys(output.modules).length > 0 &&
          Object.keys(output.modules).every(moduleMatches)
      )
      if (!chunk || chunk.type !== 'chunk') {
        throw new Error('Identity-map mutation did not find its chunk')
      }
      chunk.code += appendedCode
      chunk.map = null
      delete bundle[`${chunk.fileName}.map`]
    }
  }
}

async function buildFixture(root: string, plugins: Plugin[]): Promise<string> {
  await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [
      ...plugins,
      createRendererSourceMapProvenancePlugin(),
      createRendererSourceMapCompactionPlugin()
    ],
    build: {
      ...rendererProductionBuild,
      outDir: 'out',
      emptyOutDir: true,
      modulePreload: false,
      rollupOptions: { output: rendererProductionOutput }
    }
  })
  const provenance = readdirSync(join(root, 'out', 'source-map-provenance')).flatMap(
    (fileName) =>
      JSON.parse(readFileSync(join(root, 'out', 'source-map-provenance', fileName), 'utf8')).chunks
  ) as { file: string; sourceMap: string }[]
  const identityChunk = provenance.find((chunk) => chunk.sourceMap === 'identity-generated')
  expect(identityChunk).toBeDefined()
  return identityChunk!.file
}

function expectExactIdentityMap(root: string, outputFile: string, marker: string): void {
  const javascriptPath = join(root, 'out', outputFile)
  const javascript = readFileSync(javascriptPath, 'utf8')
  const sourceMap = JSON.parse(
    gunzipSync(readFileSync(`${javascriptPath}.map.gz`)).toString('utf8')
  ) as { sourcesContent: string[] }
  expect(javascript).toContain(marker)
  expect(sourceMap.sourcesContent).toEqual([javascript])
  expect(() => verifyLocalRendererSourceMaps('renderer', join(root, 'out'))).not.toThrow()
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('renderer identity source maps', () => {
  it('identity-maps a throwing virtual chunk after its toolchain map is removed', async () => {
    const root = createFixture("void import('virtual:crash')\n")
    const virtualModule: Plugin = {
      name: 'throwing-virtual-module',
      resolveId: (id) => (id === 'virtual:crash' ? '\0virtual:crash' : undefined),
      load: (id) =>
        id === '\0virtual:crash'
          ? 'throw new Error("identity-virtual-crash")\nexport const reached = false\n'
          : undefined
    }
    const outputFile = await buildFixture(root, [
      virtualModule,
      mutateChunk((moduleId) => moduleId.startsWith('\0') || moduleId === 'rolldown:runtime')
    ])

    expectExactIdentityMap(root, outputFile, 'identity-virtual-crash')
    const execution = spawnSync(process.execPath, [join(root, 'out', outputFile)], {
      encoding: 'utf8'
    })
    expect(execution.stderr).toContain('identity-virtual-crash')
  })

  it('identity-maps executable code appended to a generated JSON chunk', async () => {
    const root = createFixture("void import('./data.json')\n")
    writeFileSync(join(root, 'src', 'data.json'), '{"message":"identity"}\n')
    const marker = 'identity-json-crash'
    const outputFile = await buildFixture(root, [
      mutateChunk(
        (moduleId) => moduleId.split('?', 1)[0].endsWith('.json'),
        `;throw new Error(${JSON.stringify(marker)});`
      )
    ])

    expectExactIdentityMap(root, outputFile, marker)
    const execution = spawnSync(process.execPath, [join(root, 'out', outputFile)], {
      encoding: 'utf8'
    })
    expect(execution.stderr).toContain(marker)
  })
})
