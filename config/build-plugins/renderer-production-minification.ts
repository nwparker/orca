import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { BuildOptions, Plugin, Rollup } from 'vite'

export type RendererSourceMapMode =
  | 'mapped'
  | 'mappingless-json'
  | 'source-less-asset'
  | 'source-less-facade'
  | 'source-less-generated'

const sourceMapModePriority: Record<RendererSourceMapMode, number> = {
  'source-less-asset': 0,
  'source-less-facade': 1,
  'source-less-generated': 2,
  'mappingless-json': 3,
  mapped: 4
}

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

function isJsonModule(moduleId: string): boolean {
  return moduleId.split('?', 1)[0].endsWith('.json')
}

function classifySourceMap(output: Rollup.OutputAsset | Rollup.OutputChunk): RendererSourceMapMode {
  if (output.type === 'asset') {
    return 'source-less-asset'
  }
  const moduleIds = Object.keys(output.modules)
  if (
    output.code.length === 0 ||
    moduleIds.length === 0 ||
    Object.values(output.modules).every((module) => module.renderedLength === 0)
  ) {
    return 'source-less-facade'
  }
  if (moduleIds.every((moduleId) => moduleId.startsWith('\0') || moduleId === 'rolldown:runtime')) {
    return 'source-less-generated'
  }
  if (
    moduleIds.every(isJsonModule) &&
    output.map?.mappings === '' &&
    output.map.sources.length > 0
  ) {
    return 'mappingless-json'
  }
  return 'mapped'
}

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
                  sourceMap: classifySourceMap(output)
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
  const sourceMapByFile = new Map<string, RendererSourceMapMode>()
  for (const provenanceFile of provenanceFiles) {
    const provenance = JSON.parse(
      readFileSync(join(provenanceDirectory, provenanceFile), 'utf8')
    ) as { chunks: { file: string; sourceMap: RendererSourceMapMode }[] }
    for (const chunk of provenance.chunks) {
      const previous = sourceMapByFile.get(chunk.file)
      if (!previous || sourceMapModePriority[chunk.sourceMap] > sourceMapModePriority[previous]) {
        sourceMapByFile.set(chunk.file, chunk.sourceMap)
      }
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
  for (const chunk of chunks) {
    const mapPath = join(directory, `${chunk.file}.map.gz`)
    if (chunk.sourceMap.startsWith('source-less-') && existsSync(mapPath)) {
      unlinkSync(mapPath)
    }
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
      writeFileSync(`${filePath}.gz`, gzipSync(source, { level: 9 }))
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
