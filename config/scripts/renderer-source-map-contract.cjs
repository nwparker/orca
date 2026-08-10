const { readFileSync, readdirSync } = require('node:fs')
const { basename, join, relative, sep } = require('node:path')
const { gunzipSync } = require('node:zlib')
const { AnyMap, decodedMappings } = require('@jridgewell/trace-mapping')
const {
  isCompressedJavaScriptSourceMapPath,
  isJavaScriptOutputPath,
  isRawJavaScriptSourceMapPath
} = require('./renderer-javascript-output.cjs')
const { verifyBasicMappingsStrict } = require('./renderer-source-map-vlq.cjs')

const PROVENANCE_PREFIX = 'source-map-provenance/'
const SOURCE_MAP_MODES = new Set(['identity-generated', 'mapped'])
const BASIC_MAP_FIELDS = [
  'mappings',
  'names',
  'sources',
  'sourcesContent',
  'sourceRoot',
  'ignoreList',
  'x_google_ignoreList'
]

function isObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function listOutputFiles(outputDir) {
  const files = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
      } else {
        files.push(relative(outputDir, entryPath).split(sep).join('/'))
      }
    }
  }
  visit(outputDir)
  return files.sort()
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown JSON error'
    throw new Error(`${label} is not valid JSON: ${detail}`)
  }
}

function parseSourceMap(mapBytes, mapLabel) {
  let json
  try {
    json = gunzipSync(mapBytes)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown gzip error'
    throw new Error(`${mapLabel} is not valid gzip: ${detail}`)
  }
  return parseJson(json, mapLabel)
}

function assertRelativeSource(source, mapLabel) {
  if (
    source.startsWith('/') ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(source) ||
    source.includes('\\') ||
    source.includes('\0') ||
    /^<[^>]+>$/.test(source)
  ) {
    throw new Error(`${mapLabel} contains non-relative source ${source}`)
  }
}

function constructSourceMap(sourceMap, mapLabel) {
  try {
    const traceMap = new AnyMap(sourceMap)
    return { traceMap, decoded: decodedMappings(traceMap) }
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown source-map error'
    throw new Error(`${mapLabel} cannot be constructed for symbolication: ${detail}`)
  }
}

function javascriptLines(source) {
  return source.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

function verifyDecodedMappings(traceMap, decoded, mapLabel, requireMappedSegment, generatedLines) {
  let hasMappedSegment = false
  decoded.forEach((line, lineIndex) => {
    let previousColumn = -1
    line.forEach((segment, segmentIndex) => {
      if (!Array.isArray(segment) || ![1, 4, 5].includes(segment.length)) {
        throw new Error(`${mapLabel} has invalid decoded segment ${lineIndex}:${segmentIndex}`)
      }
      if (!segment.every(Number.isInteger) || segment[0] < 0 || segment[0] < previousColumn) {
        throw new Error(`${mapLabel} has invalid generated column at ${lineIndex}:${segmentIndex}`)
      }
      if (
        generatedLines &&
        (lineIndex >= generatedLines.length || segment[0] > generatedLines[lineIndex].length)
      ) {
        throw new Error(
          `${mapLabel} has out-of-range generated position at ${lineIndex}:${segmentIndex}`
        )
      }
      previousColumn = segment[0]
      if (segment.length === 1) {
        return
      }
      hasMappedSegment = true
      if (
        segment[1] < 0 ||
        segment[1] >= traceMap.sources.length ||
        segment[2] < 0 ||
        segment[3] < 0
      ) {
        throw new Error(`${mapLabel} has invalid source position at ${lineIndex}:${segmentIndex}`)
      }
      if (segment.length === 5 && (segment[4] < 0 || segment[4] >= traceMap.names.length)) {
        throw new Error(`${mapLabel} has invalid name index at ${lineIndex}:${segmentIndex}`)
      }
    })
  })
  if (requireMappedSegment && !hasMappedSegment) {
    throw new Error(`${mapLabel} has no usable source mappings`)
  }
}

function verifyIdentityMap(sourceMap, decoded, mapLabel, javascriptEntry, javascriptSource) {
  const expectedSource = `source-map-identity/${basename(javascriptEntry)}`
  if (
    sourceMap.sources.length !== 1 ||
    sourceMap.sources[0] !== expectedSource ||
    sourceMap.names.length !== 0 ||
    sourceMap.sourceRoot !== undefined ||
    sourceMap.sourcesContent[0] !== javascriptSource
  ) {
    throw new Error(`${mapLabel} is not an exact self-contained identity map`)
  }
  const lines = javascriptLines(javascriptSource)
  if (decoded.length !== lines.length) {
    throw new Error(`${mapLabel} does not map every generated line exactly`)
  }
  decoded.forEach((line, lineIndex) => {
    if (
      line.length !== lines[lineIndex].length + 1 ||
      line.some(
        (segment, column) =>
          segment.length !== 4 ||
          segment[0] !== column ||
          segment[1] !== 0 ||
          segment[2] !== lineIndex ||
          segment[3] !== column
      )
    ) {
      throw new Error(`${mapLabel} does not preserve generated coordinates exactly`)
    }
  })
}

function verifyBasicMap(
  sourceMap,
  mapLabel,
  sourceMapMode,
  javascriptEntry,
  javascriptSource,
  requireMappedSegment
) {
  if (typeof sourceMap.mappings !== 'string') {
    throw new Error(`${mapLabel} does not contain string mappings`)
  }
  if (
    !Array.isArray(sourceMap.sources) ||
    !sourceMap.sources.every((source) => typeof source === 'string')
  ) {
    throw new Error(`${mapLabel} does not list string sources`)
  }
  if (
    !Array.isArray(sourceMap.names) ||
    !sourceMap.names.every((name) => typeof name === 'string')
  ) {
    throw new Error(`${mapLabel} does not list string names`)
  }
  sourceMap.sources.forEach((source) => assertRelativeSource(source, mapLabel))
  if (sourceMap.sourceRoot !== undefined) {
    if (typeof sourceMap.sourceRoot !== 'string') {
      throw new Error(`${mapLabel} has non-string sourceRoot`)
    }
    assertRelativeSource(sourceMap.sourceRoot, mapLabel)
  }
  if (sourceMap.sources.length === 0) {
    if (
      sourceMap.sourcesContent !== undefined &&
      (!Array.isArray(sourceMap.sourcesContent) || sourceMap.sourcesContent.length !== 0)
    ) {
      throw new Error(`${mapLabel} has sourcesContent without sources`)
    }
  } else {
    if (!Array.isArray(sourceMap.sourcesContent)) {
      throw new Error(`${mapLabel} does not embed sourcesContent`)
    }
    if (sourceMap.sourcesContent.length !== sourceMap.sources.length) {
      throw new Error(
        `${mapLabel} has ${sourceMap.sourcesContent.length} sourcesContent entries for ${sourceMap.sources.length} sources`
      )
    }
    sourceMap.sources.forEach((source, index) => {
      if (typeof sourceMap.sourcesContent[index] !== 'string') {
        throw new Error(`${mapLabel} does not embed source text for ${source}`)
      }
    })
  }
  const { traceMap, decoded } = constructSourceMap(sourceMap, mapLabel)
  verifyBasicMappingsStrict(sourceMap, decoded, mapLabel)
  verifyDecodedMappings(
    traceMap,
    decoded,
    mapLabel,
    requireMappedSegment,
    javascriptSource === undefined ? undefined : javascriptLines(javascriptSource)
  )
  if (sourceMapMode === 'identity-generated') {
    verifyIdentityMap(sourceMap, decoded, mapLabel, javascriptEntry, javascriptSource)
  }
}

function verifyIndexedMap(
  sourceMap,
  mapLabel,
  javascriptEntry,
  javascriptSource,
  requireMappedSegment
) {
  const mixedField = BASIC_MAP_FIELDS.find((field) => Object.hasOwn(sourceMap, field))
  if (mixedField) {
    throw new Error(`${mapLabel} mixes indexed sections with basic field ${mixedField}`)
  }
  if (!Array.isArray(sourceMap.sections)) {
    throw new Error(`${mapLabel} has non-array indexed-map sections`)
  }
  let previousOffset
  const generatedLines =
    javascriptSource === undefined ? undefined : javascriptLines(javascriptSource)
  sourceMap.sections.forEach((section, index) => {
    if (
      !isObject(section) ||
      !isObject(section.offset) ||
      !isObject(section.map) ||
      Object.keys(section).some((key) => key !== 'offset' && key !== 'map') ||
      Object.keys(section.offset).some((key) => key !== 'line' && key !== 'column')
    ) {
      throw new Error(`${mapLabel} has invalid indexed-map section ${index}`)
    }
    const { line, column } = section.offset
    if (!Number.isInteger(line) || !Number.isInteger(column) || line < 0 || column < 0) {
      throw new Error(`${mapLabel} has invalid indexed-map offset at section ${index}`)
    }
    if (
      previousOffset &&
      (line < previousOffset.line ||
        (line === previousOffset.line && column <= previousOffset.column))
    ) {
      throw new Error(`${mapLabel} has unordered indexed-map offset at section ${index}`)
    }
    previousOffset = { line, column }
    if (generatedLines && (line >= generatedLines.length || column > generatedLines[line].length)) {
      throw new Error(`${mapLabel} has out-of-range indexed-map offset at section ${index}`)
    }
    verifySourceMapObject(
      section.map,
      `${mapLabel} section ${index}`,
      'mapped',
      javascriptEntry,
      undefined,
      false
    )
  })
  const { traceMap, decoded } = constructSourceMap(sourceMap, mapLabel)
  verifyDecodedMappings(traceMap, decoded, mapLabel, requireMappedSegment, generatedLines)
}

function verifySourceMapObject(
  sourceMap,
  mapLabel,
  sourceMapMode = 'mapped',
  javascriptEntry = 'app.js',
  javascriptSource,
  requireMappedSegment = sourceMapMode === 'mapped'
) {
  if (!isObject(sourceMap)) {
    throw new Error(`${mapLabel} is not a JSON object`)
  }
  if (sourceMap.version !== 3) {
    throw new Error(`${mapLabel} has source-map version ${String(sourceMap.version)} instead of 3`)
  }
  if (Object.hasOwn(sourceMap, 'sections')) {
    if (sourceMapMode === 'identity-generated') {
      throw new Error(`${mapLabel} uses indexed sections for an identity map`)
    }
    verifyIndexedMap(sourceMap, mapLabel, javascriptEntry, javascriptSource, requireMappedSegment)
  } else {
    verifyBasicMap(
      sourceMap,
      mapLabel,
      sourceMapMode,
      javascriptEntry,
      javascriptSource,
      requireMappedSegment
    )
  }
}

function verifySourceMapBytes(
  mapBytes,
  mapEntry,
  javascriptEntries,
  scope,
  sourceMapMode = 'mapped',
  javascriptBytes
) {
  const javascriptEntry = mapEntry.slice(0, -'.map.gz'.length)
  const mapLabel = `${scope} source map ${mapEntry}`
  if (!javascriptEntries.has(javascriptEntry)) {
    throw new Error(`${mapLabel} has no adjacent JavaScript asset ${javascriptEntry}`)
  }
  const sourceMap = parseSourceMap(mapBytes, mapLabel)
  if (!isObject(sourceMap)) {
    throw new Error(`${mapLabel} is not a JSON object`)
  }
  if (sourceMap.file !== basename(javascriptEntry)) {
    throw new Error(
      `${mapLabel} identifies ${String(sourceMap.file)} instead of ${basename(javascriptEntry)}`
    )
  }
  verifySourceMapObject(
    sourceMap,
    mapLabel,
    sourceMapMode,
    javascriptEntry,
    javascriptBytes.toString('utf8')
  )
}

function readSourceMapProvenance(outputDir, files, label) {
  const provenanceFiles = files.filter(
    (entry) => entry.startsWith(PROVENANCE_PREFIX) && entry.endsWith('.json')
  )
  if (provenanceFiles.length === 0) {
    throw new Error(`${label} output has no source-map provenance`)
  }
  const chunks = new Map()
  for (const entry of provenanceFiles) {
    const provenance = parseJson(
      readFileSync(join(outputDir, ...entry.split('/'))),
      `${label} ${entry}`
    )
    if (!isObject(provenance) || provenance.version !== 1 || !Array.isArray(provenance.chunks)) {
      throw new Error(`${label} ${entry} has invalid source-map provenance shape`)
    }
    provenance.chunks.forEach((chunk, index) => {
      if (
        !isObject(chunk) ||
        typeof chunk.file !== 'string' ||
        !isJavaScriptOutputPath(chunk.file) ||
        chunk.file.startsWith('/') ||
        chunk.file.includes('\\') ||
        chunk.file.split('/').includes('..') ||
        !SOURCE_MAP_MODES.has(chunk.sourceMap)
      ) {
        throw new Error(`${label} ${entry} has invalid source-map provenance chunk ${index}`)
      }
      const previous = chunks.get(chunk.file)
      if (previous !== undefined && previous !== chunk.sourceMap) {
        throw new Error(`${label} source-map provenance conflicts for ${chunk.file}`)
      }
      chunks.set(chunk.file, chunk.sourceMap)
    })
  }
  return { chunks, provenanceFiles }
}

function describeSetDifference(expected, actual) {
  const missing = [...expected].filter((entry) => !actual.has(entry)).sort()
  const stale = [...actual].filter((entry) => !expected.has(entry)).sort()
  return [
    missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
    stale.length > 0 ? `stale: ${stale.join(', ')}` : ''
  ]
    .filter(Boolean)
    .join('; ')
}

function verifyOutputCoverage(files, provenance, label) {
  const javascript = new Set(files.filter(isJavaScriptOutputPath))
  const provenanceJavascript = new Set(provenance.chunks.keys())
  const javascriptDifference = describeSetDifference(provenanceJavascript, javascript)
  if (javascriptDifference) {
    throw new Error(
      `${label} JavaScript set differs from source-map provenance (${javascriptDifference})`
    )
  }
  const expectedMaps = new Set([...provenance.chunks.keys()].map((entry) => `${entry}.map.gz`))
  const maps = new Set(files.filter(isCompressedJavaScriptSourceMapPath))
  const mapDifference = describeSetDifference(expectedMaps, maps)
  if (mapDifference) {
    throw new Error(`${label} source-map coverage differs from provenance (${mapDifference})`)
  }
  return { javascript, maps: [...maps].sort() }
}

function verifyLocalRendererSourceMaps(outputName, outputDir) {
  const label = `Local ${outputName}`
  const files = listOutputFiles(outputDir)
  const rawMaps = files.filter(isRawJavaScriptSourceMapPath)
  if (rawMaps.length > 0) {
    throw new Error(`${label} output contains raw source maps: ${rawMaps.join(', ')}`)
  }
  const provenance = readSourceMapProvenance(outputDir, files, label)
  const coverage = verifyOutputCoverage(files, provenance, label)
  for (const mapEntry of coverage.maps) {
    const javascriptEntry = mapEntry.slice(0, -'.map.gz'.length)
    verifySourceMapBytes(
      readFileSync(join(outputDir, ...mapEntry.split('/'))),
      mapEntry,
      coverage.javascript,
      label,
      provenance.chunks.get(javascriptEntry),
      readFileSync(join(outputDir, ...javascriptEntry.split('/')))
    )
  }
  return { files, provenance, ...coverage }
}

module.exports = {
  PROVENANCE_PREFIX,
  describeSetDifference,
  listOutputFiles,
  readSourceMapProvenance,
  verifyLocalRendererSourceMaps,
  verifyOutputCoverage,
  verifySourceMapBytes,
  verifySourceMapObject
}
