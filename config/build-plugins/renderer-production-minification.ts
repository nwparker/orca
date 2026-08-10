import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
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

function removeSourcesContent(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(removeSourcesContent)
  } else if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    delete record.sourcesContent
    Object.values(record).forEach(removeSourcesContent)
  }
}

function compactSourceMaps(directory: string): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = join(directory, entry.name)
    if (entry.isDirectory()) {
      compactSourceMaps(filePath)
    } else if (entry.name.endsWith('.js.map')) {
      const sourceMap = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
      // Why: mappings plus the asset hash keep symbolization without 100 MB of source copies.
      removeSourcesContent(sourceMap)
      writeFileSync(`${filePath}.gz`, gzipSync(JSON.stringify(sourceMap), { level: 9 }))
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
      outDir = config.build.outDir
    },
    closeBundle: () => compactSourceMaps(outDir)
  }
}
