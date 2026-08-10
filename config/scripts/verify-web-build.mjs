import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { verifyLocalRendererSourceMaps } = require('./renderer-source-map-contract.cjs')

const indexPath = resolve('out/web/web-index.html')
const html = await readFile(indexPath, 'utf8')

const absoluteAssetReference = /\b(?:src|href)=["']\/assets\//.exec(html)

if (absoluteAssetReference) {
  console.error(
    `Web build must use relative asset URLs for reverse-proxy pairing URLs; found ${absoluteAssetReference[0]} in ${indexPath}`
  )
  process.exit(1)
}

verifyLocalRendererSourceMaps('web', resolve('out/web'))
