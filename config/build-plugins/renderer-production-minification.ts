import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { BuildOptions, Plugin } from 'vite'

export const rendererProductionBuild: Pick<BuildOptions, 'minify' | 'sourcemap'> = {
  minify: 'oxc',
  sourcemap: 'hidden'
}

export const rendererProductionMinifyOptions = {
  compress: {
    keepNames: { function: true, class: true }
  },
  mangle: {
    keepNames: { function: true, class: true }
  }
} as const

export const rendererProductionOutput = {
  keepNames: true,
  minify: rendererProductionMinifyOptions
} as const

export function createRendererSourceMapProvenancePlugin(): Plugin {
  return {
    name: 'orca-renderer-source-map-provenance',
    apply: 'build',
    generateBundle: function (_options, bundle) {
      const chunks = Object.values(bundle)
        .flatMap((output) =>
          /\.m?js$/.test(output.fileName)
            ? [
                {
                  file: output.fileName.replaceAll('\\', '/'),
                  sourceMap: output.type === 'chunk' && Boolean(output.map)
                }
              ]
            : []
        )
        .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
      if (chunks.length === 0) {
        return
      }
      const source = `${JSON.stringify({ version: 1, chunks })}\n`
      const digest = createHash('sha256').update(source).digest('hex').slice(0, 16)
      this.emitFile({
        type: 'asset',
        fileName: `source-map-provenance/bundle-${digest}.json`,
        source
      })
    }
  }
}

function listOutputFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const outputPath = prefix ? join(prefix, entry.name) : entry.name
    return entry.isDirectory()
      ? listOutputFiles(join(directory, entry.name), outputPath)
      : [outputPath.replaceAll('\\', '/')]
  })
}

function finalizeSourceMapProvenance(directory: string): void {
  const provenanceDirectory = join(directory, 'source-map-provenance')
  const provenanceFiles = readdirSync(provenanceDirectory).filter((entry) =>
    entry.endsWith('.json')
  )
  const sourceMapByFile = new Map<string, boolean>()
  for (const provenanceFile of provenanceFiles) {
    const provenance = JSON.parse(
      readFileSync(join(provenanceDirectory, provenanceFile), 'utf8')
    ) as { chunks: { file: string; sourceMap: boolean }[] }
    for (const chunk of provenance.chunks) {
      sourceMapByFile.set(chunk.file, Boolean(sourceMapByFile.get(chunk.file)) || chunk.sourceMap)
    }
  }
  const chunks = listOutputFiles(directory)
    .filter((outputPath) => /\.m?js$/.test(outputPath))
    .sort()
    .map((file) => {
      const sourceMap = sourceMapByFile.get(file)
      if (sourceMap === undefined) {
        throw new Error(`Missing bundler source-map provenance for ${file}`)
      }
      return { file, sourceMap }
    })
  for (const provenanceFile of provenanceFiles) {
    unlinkSync(join(provenanceDirectory, provenanceFile))
  }
  writeFileSync(
    join(provenanceDirectory, 'complete.json'),
    `${JSON.stringify({ version: 1, chunks })}\n`
  )
}

function compactSourceMaps(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      compactSourceMaps(filePath)
    } else if (entry.name.endsWith('.js.map')) {
      const source = readFileSync(filePath)
      const sourceMap = JSON.parse(source.toString('utf8')) as {
        mappings?: unknown
        sources?: unknown[]
      }
      const compactedSource =
        sourceMap.mappings === '' && sourceMap.sources?.length
          ? Buffer.from(JSON.stringify({ ...sourceMap, mappings: 'AAAA' }))
          : source
      writeFileSync(`${filePath}.gz`, gzipSync(compactedSource, { level: 9 }))
      unlinkSync(filePath)
    }
  }
}

export function createRendererSourceMapCompactionPlugin(): Plugin {
  let outDir = ''
  return {
    name: 'orca-renderer-source-map-compaction',
    apply: 'build',
    configResolved: (config) => {
      outDir = isAbsolute(config.build.outDir)
        ? config.build.outDir
        : resolve(config.root, config.build.outDir)
    },
    closeBundle: () => {
      compactSourceMaps(outDir)
      finalizeSourceMapProvenance(outDir)
    }
  }
}
