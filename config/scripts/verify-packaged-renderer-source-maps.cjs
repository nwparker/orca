const { readFileSync, readdirSync } = require('node:fs')
const { basename, join, relative, resolve, sep } = require('node:path')
const { gunzipSync } = require('node:zlib')

const OUTPUT_NAMES = ['renderer', 'web']

function normalizeAsarEntry(entry) {
  return entry.replace(/^[/\\]+/, '').replaceAll('\\', '/')
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

function extractArchiveFile(asar, asarPath, archiveEntry) {
  return asar.extractFile(asarPath, archiveEntry.replace(/^[\\/]+/, ''))
}

function parseSourceMap(mapBytes, mapLabel) {
  let json
  try {
    json = gunzipSync(mapBytes).toString('utf8')
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown gzip error'
    throw new Error(`${mapLabel} is not valid gzip: ${detail}`)
  }
  try {
    return JSON.parse(json)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown JSON error'
    throw new Error(`${mapLabel} is not valid JSON: ${detail}`)
  }
}

function containsSourcesContent(value) {
  if (!value || typeof value !== 'object') {
    return false
  }
  if (Array.isArray(value)) {
    return value.some(containsSourcesContent)
  }
  return Object.entries(value).some(
    ([key, nestedValue]) => key === 'sourcesContent' || containsSourcesContent(nestedValue)
  )
}

function verifySourceMap(mapBytes, mapEntry, javascriptEntries, scope) {
  const javascriptEntry = mapEntry.slice(0, -'.map.gz'.length)
  const mapLabel = `${scope} source map ${mapEntry}`
  if (!javascriptEntries.has(javascriptEntry)) {
    throw new Error(`${mapLabel} has no adjacent JavaScript asset ${javascriptEntry}`)
  }
  const sourceMap = parseSourceMap(mapBytes, mapLabel)
  if (!sourceMap || typeof sourceMap !== 'object' || Array.isArray(sourceMap)) {
    throw new Error(`${mapLabel} is not a JSON object`)
  }
  if (sourceMap.version !== 3) {
    throw new Error(`${mapLabel} has source-map version ${String(sourceMap.version)} instead of 3`)
  }
  if (sourceMap.file !== basename(javascriptEntry)) {
    throw new Error(
      `${mapLabel} identifies ${String(sourceMap.file)} instead of ${basename(javascriptEntry)}`
    )
  }
  if (containsSourcesContent(sourceMap)) {
    throw new Error(`${mapLabel} contains sourcesContent`)
  }
}

function verifyOutputSourceMaps({
  outputName,
  outputDir,
  asar,
  asarPath,
  archiveEntryByNormalizedPath
}) {
  const archivePrefix = `out/${outputName}/`
  const localFiles = listOutputFiles(outputDir)
  const localRawMaps = localFiles.filter((entry) => entry.endsWith('.js.map'))
  if (localRawMaps.length > 0) {
    throw new Error(
      `Local ${outputName} output contains raw source maps: ${localRawMaps.join(', ')}`
    )
  }

  const archiveEntries = [...archiveEntryByNormalizedPath.keys()]
    .filter((entry) => entry.startsWith(archivePrefix))
    .map((entry) => entry.slice(archivePrefix.length))
    .sort()
  const packagedRawMaps = archiveEntries.filter((entry) => entry.endsWith('.js.map'))
  if (packagedRawMaps.length > 0) {
    throw new Error(
      `Packaged ${outputName} output contains raw source maps: ${packagedRawMaps.join(', ')}`
    )
  }

  const localMaps = localFiles.filter((entry) => entry.endsWith('.js.map.gz'))
  if (localMaps.length === 0) {
    throw new Error(`Local ${outputName} output has no compressed source maps: ${outputDir}`)
  }
  const packagedMaps = archiveEntries.filter((entry) => entry.endsWith('.js.map.gz'))
  const packagedMapSet = new Set(packagedMaps)
  const localMapSet = new Set(localMaps)
  const missingMaps = localMaps.filter((entry) => !packagedMapSet.has(entry))
  const staleMaps = packagedMaps.filter((entry) => !localMapSet.has(entry))
  if (missingMaps.length > 0 || staleMaps.length > 0) {
    const differences = [
      missingMaps.length > 0 ? `missing: ${missingMaps.join(', ')}` : '',
      staleMaps.length > 0 ? `stale: ${staleMaps.join(', ')}` : ''
    ].filter(Boolean)
    throw new Error(
      `Packaged ${outputName} source-map set differs from local output (${differences.join('; ')})`
    )
  }

  const localJavaScript = new Set(localFiles.filter((entry) => entry.endsWith('.js')))
  const packagedJavaScript = new Set(archiveEntries.filter((entry) => entry.endsWith('.js')))
  for (const mapEntry of localMaps) {
    const archiveMapEntry = `${archivePrefix}${mapEntry}`
    const localMapBytes = readFileSync(join(outputDir, ...mapEntry.split('/')))
    const packagedMapBytes = extractArchiveFile(
      asar,
      asarPath,
      archiveEntryByNormalizedPath.get(archiveMapEntry)
    )
    if (!localMapBytes.equals(packagedMapBytes)) {
      throw new Error(
        `Packaged ${outputName} source map ${mapEntry} differs from the local build output`
      )
    }
    verifySourceMap(localMapBytes, mapEntry, localJavaScript, `Local ${outputName}`)
    verifySourceMap(packagedMapBytes, mapEntry, packagedJavaScript, `Packaged ${outputName}`)
  }
}

function verifyPackagedRendererSourceMaps(
  resourcesDir,
  asar,
  outputDirectories = {
    renderer: resolve('out', 'renderer'),
    web: resolve('out', 'web')
  }
) {
  const asarPath = join(resourcesDir, 'app.asar')
  const archiveEntryByNormalizedPath = new Map(
    asar.listPackage(asarPath).map((entry) => [normalizeAsarEntry(entry), entry])
  )
  for (const outputName of OUTPUT_NAMES) {
    verifyOutputSourceMaps({
      outputName,
      outputDir: outputDirectories[outputName],
      asar,
      asarPath,
      archiveEntryByNormalizedPath
    })
  }
}

module.exports = {
  containsSourcesContent,
  listOutputFiles,
  normalizeAsarEntry,
  verifyPackagedRendererSourceMaps
}
