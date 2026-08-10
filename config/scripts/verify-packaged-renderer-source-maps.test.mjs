import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeAsarEntry,
  verifyPackagedRendererSourceMaps
} from './verify-packaged-renderer-source-maps.cjs'

const temporaryRoots = []
const mappedAssets = ['index-entry.js', 'shared.js', 'dynamic.js']

function sourceMap(file, sourcesContent) {
  const map = { version: 3, file, names: [], sources: [`src/${file}.ts`], mappings: '' }
  if (sourcesContent !== undefined) {
    map.sourcesContent = sourcesContent
  }
  return gzipSync(JSON.stringify(map))
}

function createFixture(mutateArchive = () => {}) {
  const rendererOutputDir = mkdtempSync(join(tmpdir(), 'orca-renderer-maps-'))
  temporaryRoots.push(rendererOutputDir)
  const archiveFiles = new Map()
  for (const asset of [...mappedAssets, 'source-less-facade.js']) {
    archiveFiles.set(`out/renderer/assets/${asset}`, Buffer.from('fixture JavaScript'))
  }
  for (const asset of mappedAssets) {
    const mapEntry = `out/renderer/assets/${asset}.map.gz`
    archiveFiles.set(mapEntry, sourceMap(asset))
    const outputMapPath = join(rendererOutputDir, 'assets', `${asset}.map.gz`)
    mkdirSync(dirname(outputMapPath), { recursive: true })
    writeFileSync(outputMapPath, 'expected map marker')
  }
  mutateArchive(archiveFiles)

  const windowsArchiveFiles = new Map(
    [...archiveFiles].map(([entry, contents]) => [entry.replaceAll('/', '\\'), contents])
  )
  const asar = {
    listPackage: () => [...windowsArchiveFiles.keys()].map((entry) => `\\${entry}`),
    extractFile: (_asarPath, entry) => {
      const contents = windowsArchiveFiles.get(entry)
      if (!contents) {
        throw new Error(`Unexpected archive entry: ${entry}`)
      }
      return contents
    }
  }
  return { asar, rendererOutputDir }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('packaged renderer source maps', () => {
  it('accepts every map-bearing Windows output while allowing a source-less facade', () => {
    const { asar, rendererOutputDir } = createFixture()

    expect(() =>
      verifyPackagedRendererSourceMaps('resources', asar, rendererOutputDir)
    ).not.toThrow()
    expect(normalizeAsarEntry('\\out\\renderer\\assets\\index.js')).toBe(
      'out/renderer/assets/index.js'
    )
  })

  it('rejects a missing shared or dynamic chunk map', () => {
    const { asar, rendererOutputDir } = createFixture((files) => {
      files.delete('out/renderer/assets/dynamic.js.map.gz')
    })

    expect(() => verifyPackagedRendererSourceMaps('resources', asar, rendererOutputDir)).toThrow(
      'Packaged renderer is missing source maps: out/renderer/assets/dynamic.js.map.gz'
    )
  })

  it.each([
    ['non-gzip', Buffer.from('{"version":3}')],
    ['non-JSON', gzipSync('not JSON')]
  ])('rejects a %s map', (_case, corruptMap) => {
    const { asar, rendererOutputDir } = createFixture((files) => {
      files.set('out/renderer/assets/shared.js.map.gz', corruptMap)
    })

    expect(() => verifyPackagedRendererSourceMaps('resources', asar, rendererOutputDir)).toThrow(
      /shared\.js\.map\.gz is not valid gzip JSON/
    )
  })

  it('rejects raw source-map leakage', () => {
    const { asar, rendererOutputDir } = createFixture((files) => {
      files.set('out/renderer/assets/index-entry.js.map', Buffer.from('{}'))
    })

    expect(() => verifyPackagedRendererSourceMaps('resources', asar, rendererOutputDir)).toThrow(
      'Packaged renderer contains raw source maps: out/renderer/assets/index-entry.js.map'
    )
  })

  it('rejects embedded sourcesContent', () => {
    const { asar, rendererOutputDir } = createFixture((files) => {
      files.set(
        'out/renderer/assets/index-entry.js.map.gz',
        sourceMap('index-entry.js', ['source'])
      )
    })

    expect(() => verifyPackagedRendererSourceMaps('resources', asar, rendererOutputDir)).toThrow(
      'out/renderer/assets/index-entry.js.map.gz contains sourcesContent'
    )
  })

  it('rejects a map without its adjacent JavaScript asset', () => {
    const { asar, rendererOutputDir } = createFixture((files) => {
      files.delete('out/renderer/assets/shared.js')
    })

    expect(() => verifyPackagedRendererSourceMaps('resources', asar, rendererOutputDir)).toThrow(
      'out/renderer/assets/shared.js.map.gz has no adjacent JavaScript asset out/renderer/assets/shared.js'
    )
  })

  it('rejects a map that identifies a different JavaScript asset', () => {
    const { asar, rendererOutputDir } = createFixture((files) => {
      files.set('out/renderer/assets/shared.js.map.gz', sourceMap('other.js'))
    })

    expect(() => verifyPackagedRendererSourceMaps('resources', asar, rendererOutputDir)).toThrow(
      'out/renderer/assets/shared.js.map.gz identifies other.js instead of shared.js'
    )
  })
})
