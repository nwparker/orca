import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  normalizeAsarEntry,
  verifyPackagedRendererSourceMaps
} from './verify-packaged-renderer-source-maps.cjs'

const outputNames = ['renderer', 'web']
const temporaryRoots = []
const mappedAssets = ['index-entry.js', 'shared.js', 'dynamic.js']

function sourceMap(file, overrides = {}) {
  return gzipSync(
    JSON.stringify({
      version: 3,
      file,
      names: [],
      sources: [`src/${file}.ts`],
      mappings: '',
      ...overrides
    })
  )
}

function writeOutputFile(outputDir, relativePath, contents) {
  const filePath = join(outputDir, ...relativePath.split('/'))
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, contents)
}

function createFixture(mutate = () => {}) {
  const root = mkdtempSync(join(tmpdir(), 'orca-renderer-maps-'))
  temporaryRoots.push(root)
  const outputDirectories = Object.fromEntries(
    outputNames.map((outputName) => [outputName, join(root, outputName)])
  )
  const archiveFiles = new Map()
  for (const outputName of outputNames) {
    const outputDir = outputDirectories[outputName]
    for (const asset of [...mappedAssets, 'source-less-facade.js']) {
      const contents = Buffer.from(`${outputName} fixture JavaScript`)
      writeOutputFile(outputDir, `assets/${asset}`, contents)
      archiveFiles.set(`out/${outputName}/assets/${asset}`, contents)
    }
    for (const asset of mappedAssets) {
      const contents = sourceMap(asset)
      writeOutputFile(outputDir, `assets/${asset}.map.gz`, contents)
      archiveFiles.set(`out/${outputName}/assets/${asset}.map.gz`, contents)
    }
  }

  const fixture = {
    archiveFiles,
    outputDirectories,
    deleteLocal(outputName, relativePath) {
      rmSync(join(outputDirectories[outputName], ...relativePath.split('/')), { force: true })
    },
    deletePackaged(outputName, relativePath) {
      archiveFiles.delete(`out/${outputName}/${relativePath}`)
    },
    readLocal(outputName, relativePath) {
      return readFileSync(join(outputDirectories[outputName], ...relativePath.split('/')))
    },
    writeLocal(outputName, relativePath, contents) {
      writeOutputFile(outputDirectories[outputName], relativePath, contents)
    },
    writePackaged(outputName, relativePath, contents) {
      archiveFiles.set(`out/${outputName}/${relativePath}`, contents)
    },
    writeMapPair(outputName, asset, contents) {
      writeOutputFile(outputDirectories[outputName], `assets/${asset}.map.gz`, contents)
      archiveFiles.set(`out/${outputName}/assets/${asset}.map.gz`, contents)
    }
  }
  mutate(fixture)

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
  return { asar, outputDirectories }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('packaged renderer source maps', () => {
  it('accepts exact Windows-style renderer and web maps plus source-less facades', () => {
    const { asar, outputDirectories } = createFixture()

    expect(() =>
      verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)
    ).not.toThrow()
    expect(normalizeAsarEntry('\\out\\renderer\\assets\\index.js')).toBe(
      'out/renderer/assets/index.js'
    )
  })

  describe.each(outputNames)('%s output', (outputName) => {
    it('rejects a byte-mismatched packaged map', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        const localMap = fixture.readLocal(outputName, 'assets/shared.js.map.gz')
        fixture.writePackaged(
          outputName,
          'assets/shared.js.map.gz',
          Buffer.concat([localMap, Buffer.from('mismatch')])
        )
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Packaged ${outputName} source map assets/shared.js.map.gz differs`
      )
    })

    it('rejects a missing packaged shared or dynamic map', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        fixture.deletePackaged(outputName, 'assets/dynamic.js.map.gz')
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Packaged ${outputName} source-map set differs from local output (missing: assets/dynamic.js.map.gz)`
      )
    })

    it('rejects a stale packaged map', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        fixture.writePackaged(outputName, 'assets/stale.js', Buffer.from('stale JavaScript'))
        fixture.writePackaged(outputName, 'assets/stale.js.map.gz', sourceMap('stale.js'))
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Packaged ${outputName} source-map set differs from local output (stale: assets/stale.js.map.gz)`
      )
    })

    it('rejects a local raw map', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        fixture.writeLocal(outputName, 'assets/index-entry.js.map', Buffer.from('{}'))
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Local ${outputName} output contains raw source maps: assets/index-entry.js.map`
      )
    })

    it('rejects a packaged raw map', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        fixture.writePackaged(outputName, 'assets/index-entry.js.map', Buffer.from('{}'))
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Packaged ${outputName} output contains raw source maps: assets/index-entry.js.map`
      )
    })

    it('rejects a corrupt gzip map', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        fixture.writeMapPair(outputName, 'shared.js', Buffer.from('not gzip'))
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Local ${outputName} source map assets/shared.js.map.gz is not valid gzip`
      )
    })

    it('rejects a gzip map containing invalid JSON', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        fixture.writeMapPair(outputName, 'shared.js', gzipSync('not JSON'))
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Local ${outputName} source map assets/shared.js.map.gz is not valid JSON`
      )
    })

    it('rejects an invalid source-map version', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        fixture.writeMapPair(outputName, 'shared.js', sourceMap('shared.js', { version: 2 }))
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Local ${outputName} source map assets/shared.js.map.gz has source-map version 2 instead of 3`
      )
    })

    it('rejects a map identifying a different JavaScript asset', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        fixture.writeMapPair(outputName, 'shared.js', sourceMap('other.js'))
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Local ${outputName} source map assets/shared.js.map.gz identifies other.js instead of shared.js`
      )
    })

    it('rejects a local map without adjacent JavaScript', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        fixture.deleteLocal(outputName, 'assets/shared.js')
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Local ${outputName} source map assets/shared.js.map.gz has no adjacent JavaScript asset assets/shared.js`
      )
    })

    it('rejects a packaged map without adjacent JavaScript', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        fixture.deletePackaged(outputName, 'assets/shared.js')
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Packaged ${outputName} source map assets/shared.js.map.gz has no adjacent JavaScript asset assets/shared.js`
      )
    })

    it('rejects recursively nested sourcesContent', () => {
      const { asar, outputDirectories } = createFixture((fixture) => {
        fixture.writeMapPair(
          outputName,
          'shared.js',
          sourceMap('shared.js', { sections: [{ map: { sourcesContent: ['source'] } }] })
        )
      })

      expect(() => verifyPackagedRendererSourceMaps('resources', asar, outputDirectories)).toThrow(
        `Local ${outputName} source map assets/shared.js.map.gz contains sourcesContent`
      )
    })
  })
})
