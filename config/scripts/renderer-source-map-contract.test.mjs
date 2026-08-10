import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { createRendererIdentitySourceMap } from '../build-plugins/renderer-identity-source-map'
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

function createFixture(
  sourceMap = basicMap(),
  sourceMapMode = 'mapped',
  javascript = 'throw new Error("contract")'
) {
  const root = mkdtempSync(join(tmpdir(), 'orca-source-map-contract-'))
  temporaryRoots.push(root)
  writeFixtureFile(root, 'assets/app.js', javascript)
  writeFixtureFile(
    root,
    'source-map-provenance/bundle-fixture.json',
    `${JSON.stringify({
      version: 1,
      chunks: [{ file: 'assets/app.js', sourceMap: sourceMapMode }]
    })}\n`
  )
  writeFixtureFile(root, 'assets/app.js.map.gz', gzipSync(JSON.stringify(sourceMap)))
  return root
}

function verifyFixture(sourceMap, sourceMapMode = 'mapped', javascript) {
  const root = createFixture(sourceMap, sourceMapMode, javascript)
  return () => verifyLocalRendererSourceMaps('renderer', root)
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('renderer source-map contract', () => {
  it('constructs a basic mapped map', () => {
    expect(verifyFixture(basicMap())).not.toThrow()
  })

  it('rejects a zero-source basic map as mapped provenance', () => {
    expect(
      verifyFixture(basicMap({ sources: [], sourcesContent: undefined, mappings: '' }))
    ).toThrow('has no usable source mappings')
  })

  it('keeps duplicate generated columns emitted by the toolchain valid', () => {
    expect(verifyFixture(basicMap({ mappings: 'AAAA,AAAA' }))).not.toThrow()
  })

  it('accepts an exact self-contained identity map', () => {
    const javascript = 'throw new Error("identity")\r\n'
    const sourceMap = JSON.parse(createRendererIdentitySourceMap('assets/app.js', javascript))
    expect(verifyFixture(sourceMap, 'identity-generated', javascript)).not.toThrow()
  })

  it('rejects identity provenance backed by inexact source text or coordinates', () => {
    const javascript = 'throw new Error("identity")'
    const sourceMap = JSON.parse(createRendererIdentitySourceMap('assets/app.js', javascript))
    sourceMap.sourcesContent[0] = `${javascript} changed`
    expect(verifyFixture(sourceMap, 'identity-generated', javascript)).toThrow(
      'is not an exact self-contained identity map'
    )
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
    expect(verifyFixture(basicMap({ mappings: '!bad' }))).toThrow('has an invalid VLQ character')
  })

  it('rejects a negative decoded generated column', () => {
    expect(verifyFixture(basicMap({ mappings: 'DAAA' }))).toThrow('has invalid generated column')
  })

  it.each([
    ['AA', 'two-field', 'has invalid decoded segment'],
    ['AAA', 'three-field', 'has invalid decoded segment'],
    ['AAAAAA', 'six-field', 'has invalid decoded segment'],
    ['g', 'truncated', 'has a truncated VLQ value'],
    ['ADAA', 'negative source index', 'has invalid source position'],
    ['ACAA', 'out-of-range source index', 'has invalid source position'],
    ['AADA', 'negative original line', 'has invalid source position'],
    ['AACA', 'out-of-range original line', 'has out-of-range original position'],
    ['AAAD', 'negative original column', 'has invalid source position'],
    ['AAAAD', 'negative name index', 'has invalid name index'],
    ['AAAAC', 'out-of-range name index', 'has invalid name index']
  ])('rejects a %s VLQ segment (%s)', (mappings, _case, error) => {
    expect(verifyFixture(basicMap({ mappings }))).toThrow(error)
  })

  it('rejects an original column beyond the embedded source line', () => {
    expect(verifyFixture(basicMap({ sourcesContent: ['x'], mappings: 'AAAE' }))).toThrow(
      'has out-of-range original position'
    )
  })

  it.each([
    ['IAAA', 'column'],
    [';;AAAA', 'line']
  ])('rejects a generated position beyond the adjacent JavaScript %s', (mappings) => {
    expect(verifyFixture(basicMap({ mappings }), 'mapped', 'abc')).toThrow(
      'has out-of-range generated position'
    )
  })

  it('accepts generated positions on UTF-16 CRLF boundaries', () => {
    expect(
      verifyFixture(
        basicMap({ sourcesContent: ['abc\r\nx'], mappings: 'GAAA;CACC' }),
        'mapped',
        'abc\r\nx'
      )
    ).not.toThrow()
  })

  it('rejects an absolute sourceRoot', () => {
    expect(verifyFixture(basicMap({ sourceRoot: '/checkout' }))).toThrow(
      'contains non-relative source /checkout'
    )
  })

  it.each(['file:///checkout/app.ts', 'https://example.test/app.ts', 'custom+source:app.ts'])(
    'rejects a URI source: %s',
    (source) => {
      expect(verifyFixture(basicMap({ sources: [source] }))).toThrow(
        `contains non-relative source ${source}`
      )
    }
  )

  it.each(['file:///checkout', 'https://example.test/src', 'custom+root:src'])(
    'rejects a URI sourceRoot: %s',
    (sourceRoot) => {
      expect(verifyFixture(basicMap({ sourceRoot }))).toThrow(
        `contains non-relative source ${sourceRoot}`
      )
    }
  )

  it.each(['AAAA,', ',AAAA', 'AAAA,,AAAA'])(
    'rejects an empty lexical VLQ segment: %s',
    (mappings) => {
      expect(verifyFixture(basicMap({ mappings }))).toThrow('has an empty VLQ segment')
    }
  )

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
        { offset: { line: 0, column: 1 }, map: sectionMap() },
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

  it('rejects a zero-source indexed map as mapped provenance', () => {
    expect(
      verifyFixture(
        indexedMap([
          {
            offset: { line: 0, column: 0 },
            map: { version: 3, names: [], sources: [], mappings: 'A' }
          }
        ])
      )
    ).toThrow('has no usable source mappings')
  })

  it.each([
    [{ line: 1, column: 0 }, sectionMap(), 'line'],
    [{ line: 0, column: 4 }, sectionMap(), 'column'],
    [{ line: 0, column: 3 }, { ...sectionMap(), mappings: 'CAAA' }, 'mapped column']
  ])('rejects an indexed generated position beyond the adjacent JavaScript (%s)', (offset, map) => {
    expect(verifyFixture(indexedMap([{ offset, map }]), 'mapped', 'abc')).toThrow(
      /out-of-range (?:indexed-map offset|generated position)/
    )
  })

  it('accepts an indexed section on the adjacent JavaScript boundary', () => {
    expect(
      verifyFixture(
        indexedMap([{ offset: { line: 0, column: 3 }, map: sectionMap() }]),
        'mapped',
        'abc'
      )
    ).not.toThrow()
  })

  it('rejects null source text for a relative source', () => {
    expect(
      verifyFixture(
        basicMap({ sources: ['src/spoofed.ts'], sourcesContent: [null], mappings: 'AAAA' })
      )
    ).toThrow('does not embed source text for src/spoofed.ts')
  })
})
