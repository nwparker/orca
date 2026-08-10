const { readdirSync } = require('node:fs')
const { basename, join, relative, resolve, sep } = require('node:path')
const { gunzipSync } = require('node:zlib')

const RENDERER_ARCHIVE_PREFIX = 'out/renderer/'

function normalizeAsarEntry(entry) {
  return entry.replace(/^[/\\]+/, '').replaceAll('\\', '/')
}

function listRendererSourceMaps(rendererOutputDir) {
  const maps = []
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = join(directory, entry.name)
      if (entry.isDirectory()) {
        visit(entryPath)
      } else if (entry.name.endsWith('.js.map.gz')) {
        maps.push(
          `${RENDERER_ARCHIVE_PREFIX}${relative(rendererOutputDir, entryPath).split(sep).join('/')}`
        )
      }
    }
  }
  visit(rendererOutputDir)
  return maps.sort()
}

function extractArchiveFile(asar, asarPath, archiveEntry) {
  return asar.extractFile(asarPath, archiveEntry.replace(/^[\\/]+/, ''))
}

function parsePackagedSourceMap(asar, asarPath, mapEntry, archiveEntry) {
  try {
    const contents = extractArchiveFile(asar, asarPath, archiveEntry)
    return JSON.parse(gunzipSync(contents).toString('utf8'))
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'unknown parse error'
    throw new Error(`Packaged renderer source map ${mapEntry} is not valid gzip JSON: ${detail}`)
  }
}

function verifyPackagedRendererSourceMaps(
  resourcesDir,
  asar,
  rendererOutputDir = resolve('out', 'renderer')
) {
  const asarPath = join(resourcesDir, 'app.asar')
  const archiveEntryByNormalizedPath = new Map(
    asar.listPackage(asarPath).map((entry) => [normalizeAsarEntry(entry), entry])
  )
  const archiveEntries = [...archiveEntryByNormalizedPath.keys()]
  const rawMaps = archiveEntries.filter((entry) => /^out\/renderer\/.*\.js\.map$/.test(entry))
  if (rawMaps.length > 0) {
    throw new Error(`Packaged renderer contains raw source maps: ${rawMaps.sort().join(', ')}`)
  }

  const expectedMaps = listRendererSourceMaps(rendererOutputDir)
  if (expectedMaps.length === 0) {
    throw new Error(`Renderer output has no compressed source maps: ${rendererOutputDir}`)
  }
  const missingMaps = expectedMaps.filter((entry) => !archiveEntryByNormalizedPath.has(entry))
  if (missingMaps.length > 0) {
    throw new Error(`Packaged renderer is missing source maps: ${missingMaps.join(', ')}`)
  }

  const packagedMaps = archiveEntries.filter((entry) =>
    /^out\/renderer\/.*\.js\.map\.gz$/.test(entry)
  )
  for (const mapEntry of packagedMaps) {
    const javascriptEntry = mapEntry.slice(0, -'.map.gz'.length)
    if (!archiveEntryByNormalizedPath.has(javascriptEntry)) {
      throw new Error(
        `Packaged renderer source map ${mapEntry} has no adjacent JavaScript asset ${javascriptEntry}`
      )
    }
    const sourceMap = parsePackagedSourceMap(
      asar,
      asarPath,
      mapEntry,
      archiveEntryByNormalizedPath.get(mapEntry)
    )
    if (!sourceMap || typeof sourceMap !== 'object' || Array.isArray(sourceMap)) {
      throw new Error(`Packaged renderer source map ${mapEntry} is not a JSON object`)
    }
    if (Object.prototype.hasOwnProperty.call(sourceMap, 'sourcesContent')) {
      throw new Error(`Packaged renderer source map ${mapEntry} contains sourcesContent`)
    }
    if (sourceMap.file !== basename(javascriptEntry)) {
      throw new Error(
        `Packaged renderer source map ${mapEntry} identifies ${String(sourceMap.file)} instead of ${basename(javascriptEntry)}`
      )
    }
  }
}

module.exports = {
  listRendererSourceMaps,
  normalizeAsarEntry,
  verifyPackagedRendererSourceMaps
}
