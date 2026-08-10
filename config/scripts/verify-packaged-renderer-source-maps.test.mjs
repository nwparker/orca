import { describe, expect, it } from 'vitest'
import {
  normalizeAsarEntry,
  verifyPackagedRendererSourceMaps
} from './verify-packaged-renderer-source-maps.cjs'

describe('packaged renderer source maps', () => {
  it('accepts Windows-style asar paths with maps adjacent to every renderer chunk', () => {
    const html = (entry) => `<script type="module" src="./assets/${entry}.js"></script>`
    const asar = {
      listPackage: () => [
        '\\out\\renderer\\index.html',
        '\\out\\renderer\\web-index.html',
        '\\out\\renderer\\popout.html',
        '\\out\\renderer\\assets\\index-abc.js.map.gz',
        '\\out\\renderer\\assets\\web-def.js.map.gz',
        '\\out\\renderer\\assets\\popout-ghi.js.map.gz'
      ],
      extractFile: (_asarPath, entry) =>
        Buffer.from(
          entry.endsWith('web-index.html')
            ? html('web-def')
            : entry.endsWith('popout.html')
              ? html('popout-ghi')
              : html('index-abc')
        )
    }

    expect(() => verifyPackagedRendererSourceMaps('resources', asar)).not.toThrow()
    expect(normalizeAsarEntry('\\out\\renderer\\assets\\index.js')).toBe(
      'out/renderer/assets/index.js'
    )
  })

  it('fails packaging when a renderer chunk has no matching map', () => {
    const asar = {
      listPackage: () => [
        '/out/renderer/index.html',
        '/out/renderer/web-index.html',
        '/out/renderer/popout.html',
        '/out/renderer/assets/index-abc.js.map.gz'
      ],
      extractFile: () => Buffer.from('<script type="module" src="./assets/missing.js"></script>')
    }

    expect(() => verifyPackagedRendererSourceMaps('resources', asar)).toThrow(
      'Packaged renderer entries are missing source maps: out/renderer/assets/missing.js'
    )
  })
})
