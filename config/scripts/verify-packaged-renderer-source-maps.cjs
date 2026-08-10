const { readFileSync } = require('node:fs')
const { join, resolve } = require('node:path')
const {
  PROVENANCE_PREFIX,
  describeSetDifference,
  verifyLocalRendererSourceMaps,
  verifyOutputCoverage,
  verifySourceMapBytes
} = require('./renderer-source-map-contract.cjs')
const { isRawJavaScriptSourceMapPath } = require('./renderer-javascript-output.cjs')

const OUTPUT_NAMES = ['renderer', 'web']

function normalizeAsarEntry(entry) {
  return entry.replace(/^[/\\]+/, '').replaceAll('\\', '/')
}

function extractArchiveFile(asar, asarPath, archiveEntry) {
  return asar.extractFile(asarPath, archiveEntry.replace(/^[/\\]+/, ''))
}

function verifyPackagedSet(label, expectedEntries, actualEntries) {
  const difference = describeSetDifference(new Set(expectedEntries), new Set(actualEntries))
  if (difference) {
    throw new Error(`${label} differs from local output (${difference})`)
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
  const local = verifyLocalRendererSourceMaps(outputName, outputDir)
  const archiveEntries = [...archiveEntryByNormalizedPath.keys()]
    .filter((entry) => entry.startsWith(archivePrefix))
    .map((entry) => entry.slice(archivePrefix.length))
    .sort()
  const packagedRawMaps = archiveEntries.filter(isRawJavaScriptSourceMapPath)
  if (packagedRawMaps.length > 0) {
    throw new Error(
      `Packaged ${outputName} output contains raw source maps: ${packagedRawMaps.join(', ')}`
    )
  }

  const packagedProvenanceFiles = archiveEntries.filter(
    (entry) => entry.startsWith(PROVENANCE_PREFIX) && entry.endsWith('.json')
  )
  verifyPackagedSet(
    `Packaged ${outputName} source-map provenance set`,
    local.provenance.provenanceFiles,
    packagedProvenanceFiles
  )
  for (const entry of local.provenance.provenanceFiles) {
    const localBytes = readFileSync(join(outputDir, ...entry.split('/')))
    const packagedBytes = extractArchiveFile(
      asar,
      asarPath,
      archiveEntryByNormalizedPath.get(`${archivePrefix}${entry}`)
    )
    if (!localBytes.equals(packagedBytes)) {
      const firstDifference = localBytes.findIndex((byte, index) => byte !== packagedBytes[index])
      throw new Error(
        `Packaged ${outputName} source-map provenance ${entry} differs (${localBytes.length} local bytes, ${packagedBytes.length} packaged bytes, first difference ${firstDifference}: ${localBytes[firstDifference]}/${packagedBytes[firstDifference]})`
      )
    }
  }

  const packagedCoverage = verifyOutputCoverage(
    archiveEntries,
    local.provenance,
    `Packaged ${outputName}`
  )
  for (const javascriptEntry of local.provenance.chunks.keys()) {
    const localBytes = readFileSync(join(outputDir, ...javascriptEntry.split('/')))
    const packagedBytes = extractArchiveFile(
      asar,
      asarPath,
      archiveEntryByNormalizedPath.get(`${archivePrefix}${javascriptEntry}`)
    )
    if (!localBytes.equals(packagedBytes)) {
      throw new Error(
        `Packaged ${outputName} JavaScript ${javascriptEntry} differs from the local build output`
      )
    }
  }
  verifyPackagedSet(`Packaged ${outputName} source-map set`, local.maps, packagedCoverage.maps)
  for (const mapEntry of local.maps) {
    const archiveMapEntry = `${archivePrefix}${mapEntry}`
    const javascriptEntry = mapEntry.slice(0, -'.map.gz'.length)
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
    verifySourceMapBytes(
      packagedMapBytes,
      mapEntry,
      packagedCoverage.javascript,
      `Packaged ${outputName}`,
      local.provenance.chunks.get(javascriptEntry),
      extractArchiveFile(
        asar,
        asarPath,
        archiveEntryByNormalizedPath.get(`${archivePrefix}${javascriptEntry}`)
      )
    )
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
  normalizeAsarEntry,
  verifyPackagedRendererSourceMaps
}
