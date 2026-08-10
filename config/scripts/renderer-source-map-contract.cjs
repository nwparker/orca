const { readFileSync, readdirSync } = require('node:fs')
const { basename, join, relative, sep } = require('node:path')
const { gunzipSync } = require('node:zlib')
const { AnyMap, decodedMappings } = require('@jridgewell/trace-mapping')

const PROVENANCE_PREFIX = 'source-map-provenance/'
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
  if (source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source) || source.includes('\\')) {
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

function verifyDecodedMappings(traceMap, decoded, mapLabel, requireMappedSegment) {
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

function verifyBasicMap(sourceMap, mapLabel) {
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
  verifyDecodedMappings(traceMap, decoded, mapLabel, sourceMap.sources.length > 0)
}

function verifyIndexedMap(sourceMap, mapLabel) {
  const mixedField = BASIC_MAP_FIELDS.find((field) => Object.hasOwn(sourceMap, field))
  if (mixedField) {
    throw new Error(`${mapLabel} mixes indexed sections with basic field ${mixedField}`)
  }
  if (!Array.isArray(sourceMap.sections)) {
    throw new Error(`${mapLabel} has non-array indexed-map sections`)
  }
  let previousOffset
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
    verifySourceMapObject(section.map, `${mapLabel} section ${index}`)
  })
  const { traceMap, decoded } = constructSourceMap(sourceMap, mapLabel)
  verifyDecodedMappings(traceMap, decoded, mapLabel, traceMap.sources.length > 0)
}

function verifySourceMapObject(sourceMap, mapLabel) {
  if (!isObject(sourceMap)) {
    throw new Error(`${mapLabel} is not a JSON object`)
  }
  if (sourceMap.version !== 3) {
    throw new Error(`${mapLabel} has source-map version ${String(sourceMap.version)} instead of 3`)
  }
  if (Object.hasOwn(sourceMap, 'sections')) {
    verifyIndexedMap(sourceMap, mapLabel)
  } else {
    verifyBasicMap(sourceMap, mapLabel)
  }
}

function verifySourceMapBytes(mapBytes, mapEntry, javascriptEntries, scope) {
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
  verifySourceMapObject(sourceMap, mapLabel)
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
        !/\.m?js$/.test(chunk.file) ||
        chunk.file.startsWith('/') ||
        chunk.file.includes('\\') ||
        chunk.file.split('/').includes('..') ||
        typeof chunk.sourceMap !== 'boolean'
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
  const javascript = new Set(files.filter((entry) => /\.m?js$/.test(entry)))
  const provenanceJavascript = new Set(provenance.chunks.keys())
  const javascriptDifference = describeSetDifference(provenanceJavascript, javascript)
  if (javascriptDifference) {
    throw new Error(
      `${label} JavaScript set differs from source-map provenance (${javascriptDifference})`
    )
  }
  const expectedMaps = new Set(
    [...provenance.chunks].filter(([, sourceMap]) => sourceMap).map(([entry]) => `${entry}.map.gz`)
  )
  const maps = new Set(files.filter((entry) => /\.m?js\.map\.gz$/.test(entry)))
  const mapDifference = describeSetDifference(expectedMaps, maps)
  if (mapDifference) {
    throw new Error(`${label} source-map coverage differs from provenance (${mapDifference})`)
  }
  return { javascript, maps: [...maps].sort() }
}

function verifyLocalRendererSourceMaps(outputName, outputDir) {
  const label = `Local ${outputName}`
  const files = listOutputFiles(outputDir)
  const rawMaps = files.filter((entry) => /\.m?js\.map$/.test(entry))
  if (rawMaps.length > 0) {
    throw new Error(`${label} output contains raw source maps: ${rawMaps.join(', ')}`)
  }
  const provenance = readSourceMapProvenance(outputDir, files, label)
  const coverage = verifyOutputCoverage(files, provenance, label)
  for (const mapEntry of coverage.maps) {
    verifySourceMapBytes(
      readFileSync(join(outputDir, ...mapEntry.split('/'))),
      mapEntry,
      coverage.javascript,
      label
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
