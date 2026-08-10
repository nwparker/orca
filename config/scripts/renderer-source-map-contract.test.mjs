import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyLocalRendererSourceMaps } from './renderer-source-map-contract.cjs'

const temporaryRoots = []

function basicMap(overrides = {}) {
  return {
    version: 3,
    file: 'app.js',
    names: [],
    sources: ['src/app.ts'],
    sourcesContent: ['throw new Error("contract")'],
    mappings: 'AAAA',
    ...overrides
  }
}

function sectionMap() {
  const { file: _file, ...sourceMap } = basicMap()
  return sourceMap
}

function indexedMap(sections, overrides = {}) {
  return { version: 3, file: 'app.js', sections, ...overrides }
}

function writeFixtureFile(root, relativePath, contents) {
  const filePath = join(root, ...relativePath.split('/'))
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, contents)
}

function createFixture(sourceMap = basicMap()) {
  const root = mkdtempSync(join(tmpdir(), 'orca-source-map-contract-'))
  temporaryRoots.push(root)
  writeFixtureFile(root, 'assets/app.js', 'throw new Error("contract")')
  writeFixtureFile(root, 'assets/source-less-facade.js', '')
  writeFixtureFile(
    root,
    'source-map-provenance/bundle-fixture.json',
    `${JSON.stringify({
      version: 1,
      chunks: [
        { file: 'assets/app.js', sourceMap: true },
        { file: 'assets/source-less-facade.js', sourceMap: false }
      ]
    })}\n`
  )
  writeFixtureFile(root, 'assets/app.js.map.gz', gzipSync(JSON.stringify(sourceMap)))
  return root
}

function verifyFixture(sourceMap) {
  const root = createFixture(sourceMap)
  return () => verifyLocalRendererSourceMaps('renderer', root)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('renderer source-map contract', () => {
  it('constructs a basic map and permits a provenance-backed source-less facade', () => {
    expect(verifyFixture(basicMap())).not.toThrow()
  })

  it('keeps a zero-source basic map valid', () => {
    expect(
      verifyFixture(basicMap({ sources: [], sourcesContent: undefined, mappings: '' }))
    ).not.toThrow()
  })

  it('rejects a missing mappings field', () => {
    expect(verifyFixture(basicMap({ mappings: undefined }))).toThrow(
      'does not contain string mappings'
    )
  })

  it('rejects non-string mappings', () => {
    expect(verifyFixture(basicMap({ mappings: 42 }))).toThrow('does not contain string mappings')
  })

  it('rejects a source-bearing map without a usable mapped segment', () => {
    expect(verifyFixture(basicMap({ mappings: '' }))).toThrow('has no usable source mappings')
  })

  it('rejects mappings that decode to invalid source positions', () => {
    expect(verifyFixture(basicMap({ mappings: '!bad' }))).toThrow('has invalid source position')
  })

  it('rejects a negative decoded generated column', () => {
    expect(verifyFixture(basicMap({ mappings: 'DAAA' }))).toThrow('has invalid generated column')
  })

  it('rejects an absolute sourceRoot', () => {
    expect(verifyFixture(basicMap({ sourceRoot: '/checkout' }))).toThrow(
      'contains non-relative source /checkout'
    )
  })

  it('rejects a section without an offset', () => {
    expect(verifyFixture(indexedMap([{ map: sectionMap() }]))).toThrow(
      'has invalid indexed-map section 0'
    )
  })

  it.each([
    [{ line: -1, column: 0 }, 'negative'],
    [{ line: 0, column: -1 }, 'negative column'],
    [{ line: 0.5, column: 0 }, 'fractional line'],
    [{ line: 0, column: 0.5 }, 'fractional column']
  ])('rejects a %s indexed-map offset (%s)', (offset) => {
    expect(verifyFixture(indexedMap([{ offset, map: sectionMap() }]))).toThrow(
      'has invalid indexed-map offset at section 0'
    )
  })

  it.each([
    [
      [
        { offset: { line: 1, column: 0 }, map: sectionMap() },
        { offset: { line: 0, column: 0 }, map: sectionMap() }
      ],
      'unordered'
    ],
    [
      [
        { offset: { line: 0, column: 0 }, map: sectionMap() },
        { offset: { line: 0, column: 0 }, map: sectionMap() }
      ],
      'duplicate'
    ]
  ])('rejects %s indexed-map sections (%s)', (sections) => {
    expect(verifyFixture(indexedMap(sections))).toThrow(
      'has unordered indexed-map offset at section 1'
    )
  })

  it.each([
    [{ offset: { line: 0, column: 0 } }, 'missing map'],
    [{ offset: { line: 0, column: 0 }, map: null }, 'null map'],
    [{ offset: { line: 0, column: 0, extra: 1 }, map: sectionMap() }, 'extra offset field'],
    [{ offset: { line: 0, column: 0 }, map: sectionMap(), url: 'external.map' }, 'URL']
  ])('rejects a malformed indexed-map section (%s: %s)', (section) => {
    expect(verifyFixture(indexedMap([section]))).toThrow('has invalid indexed-map section 0')
  })

  it('rejects a non-array sections field', () => {
    expect(verifyFixture(indexedMap(null))).toThrow('has non-array indexed-map sections')
  })

  it('rejects mixed indexed and basic map fields', () => {
    expect(verifyFixture(indexedMap([], { mappings: '' }))).toThrow(
      'mixes indexed sections with basic field mappings'
    )
  })

  it('rejects null source text even when the source name looks synthetic', () => {
    expect(
      verifyFixture(
        basicMap({ sources: ['virtual:spoofed'], sourcesContent: [null], mappings: 'AAAA' })
      )
    ).toThrow('does not embed source text for virtual:spoofed')
  })
})
