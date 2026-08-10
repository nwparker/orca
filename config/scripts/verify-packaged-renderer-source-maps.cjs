function normalizeAsarEntry(entry) {
  return entry.replace(/^[/\\]+/, '').replaceAll('\\', '/')
}

function verifyPackagedRendererSourceMaps(resourcesDir, asar) {
  const asarPath = require('node:path').join(resourcesDir, 'app.asar')
  const archiveEntryByNormalizedPath = new Map(
    asar.listPackage(asarPath).map((entry) => [normalizeAsarEntry(entry), entry])
  )
  const rendererMaps = [...archiveEntryByNormalizedPath.keys()].filter((entry) =>
    /^out\/renderer\/assets\/[^/]+\.js\.map\.gz$/.test(entry)
  )
  if (rendererMaps.length === 0) {
    throw new Error('Packaged app has no renderer source maps')
  }

  const missingMaps = ['index.html', 'web-index.html', 'popout.html'].flatMap((htmlFile) => {
    const htmlEntry = `out/renderer/${htmlFile}`
    const archiveHtmlEntry = archiveEntryByNormalizedPath.get(htmlEntry)
    if (!archiveHtmlEntry) {
      return [`${htmlEntry} (entry HTML missing)`]
    }
    const html = asar
      .extractFile(asarPath, archiveHtmlEntry.replace(/^[\\/]+/, ''))
      .toString('utf8')
    const script = html.match(/<script[^>]+src="\.\/(assets\/[^"?]+\.js)"/i)?.[1]
    if (!script) {
      return [`${htmlEntry} (entry script missing)`]
    }
    return archiveEntryByNormalizedPath.has(`out/renderer/${script}.map.gz`)
      ? []
      : [`out/renderer/${script}`]
  })
  if (missingMaps.length > 0) {
    throw new Error(`Packaged renderer entries are missing source maps: ${missingMaps.join(', ')}`)
  }
}

module.exports = { normalizeAsarEntry, verifyPackagedRendererSourceMaps }
