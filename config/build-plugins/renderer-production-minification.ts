import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { BuildOptions, Plugin, Rollup } from 'vite'
import { createRendererIdentitySourceMap } from './renderer-identity-source-map'

export type RendererSourceMapMode = 'identity-generated' | 'mapped'

const sourceMapModePriority: Record<RendererSourceMapMode, number> = {
  'identity-generated': 0,
  mapped: 1
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

const nodeRequire = createRequire(import.meta.url)
const { isJavaScriptOutputPath, isRawJavaScriptSourceMapPath } = nodeRequire(
  '../scripts/renderer-javascript-output.cjs'
) as {
  isJavaScriptOutputPath: (fileName: string) => boolean
  isRawJavaScriptSourceMapPath: (fileName: string) => boolean
}
const pdfWorkerPath = realpathSync(nodeRequire.resolve('pdfjs-dist/build/pdf.worker.min.mjs'))
const pdfWorkerSource = readFileSync(pdfWorkerPath)

export const rendererProductionOutput = {
  keepNames: true,
  minify: rendererProductionMinifyOptions
} as const

function isJsonModule(moduleId: string): boolean {
  return moduleId.split('?', 1)[0].endsWith('.json')
}

function isPdfWorkerAsset(output: Rollup.OutputAsset, root: string): boolean {
  if (
    output.names.length !== 1 ||
    output.names[0] !== 'pdf.worker.min.mjs' ||
    output.originalFileNames.length !== 1 ||
    !output.fileName.endsWith('.mjs')
  ) {
    return false
  }
  const originalFileName = output.originalFileNames[0].replaceAll('\\', '/')
  if (originalFileName.includes('\0') || isAbsolute(originalFileName)) {
    return false
  }
  try {
    const originalPath = realpathSync(resolve(root, ...originalFileName.split('/')))
    const source =
      typeof output.source === 'string' ? Buffer.from(output.source) : Buffer.from(output.source)
    return originalPath === pdfWorkerPath && source.equals(pdfWorkerSource)
  } catch {
    return false
  }
}

function hasUsableToolchainMap(output: Rollup.OutputChunk): boolean {
  return Boolean(output.map?.mappings && output.map.sources.length > 0)
}

function classifySourceMap(
  output: Rollup.OutputAsset | Rollup.OutputChunk,
  root: string
): RendererSourceMapMode {
  if (output.type === 'asset') {
    return isPdfWorkerAsset(output, root) ? 'identity-generated' : 'mapped'
  }
  const moduleIds = Object.keys(output.modules)
  if (
    output.code.length === 0 ||
    (output.facadeModuleId !== null &&
      (moduleIds.length === 0 ||
        Object.values(output.modules).every((module) => module.renderedLength === 0)))
  ) {
    return 'identity-generated'
  }
  if (hasUsableToolchainMap(output)) {
    return 'mapped'
  }
  if (
    moduleIds.length > 0 &&
    moduleIds.every((moduleId) => moduleId.startsWith('\0') || moduleId === 'rolldown:runtime')
  ) {
    return 'identity-generated'
  }
  if (moduleIds.length > 0 && moduleIds.every(isJsonModule)) {
    return 'identity-generated'
  }
  return 'mapped'
}

export function createRendererSourceMapProvenancePlugin(): Plugin {
  let root = ''
  return {
    name: 'orca-renderer-source-map-provenance',
    apply: 'build',
    configResolved: (config) => {
      root = config.root
    },
    generateBundle: function (_options, bundle) {
      const chunks = Object.values(bundle)
        .flatMap((output) =>
          isJavaScriptOutputPath(output.fileName)
            ? [
                {
                  file: output.fileName.replaceAll('\\', '/'),
                  sourceMap: classifySourceMap(output, root)
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
    .filter(isJavaScriptOutputPath)
    .sort()
    .map((file) => {
      const sourceMap = sourceMapByFile.get(file)
      if (sourceMap === undefined) {
        throw new Error(`Missing bundler source-map provenance for ${file}`)
      }
      return { file, sourceMap }
    })
  for (const chunk of chunks) {
    const mapPath = join(directory, `${chunk.file}.map.gz`)
    if (chunk.sourceMap === 'identity-generated') {
      const source = readFileSync(join(directory, chunk.file), 'utf8')
      const identityMap = createRendererIdentitySourceMap(chunk.file, source)
      writeFileSync(mapPath, gzipSync(identityMap, { level: 9 }))
    } else if (!existsSync(mapPath)) {
      throw new Error(`Missing compressed source map for ${chunk.file}`)
    }
  }
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
    } else if (isRawJavaScriptSourceMapPath(entry.name)) {
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
