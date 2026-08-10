import { basename } from 'node:path'

const BASE64_VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function encodeVlq(value: number): string {
  let encoded = ''
  let remaining = value < 0 ? -value * 2 + 1 : value * 2
  do {
    let digit = remaining % 32
    remaining = Math.floor(remaining / 32)
    if (remaining > 0) {
      digit += 32
    }
    encoded += BASE64_VLQ[digit]
  } while (remaining > 0)
  return encoded
}

function identityMappings(source: string): string {
  let previousOriginalLine = 0
  let previousOriginalColumn = 0
  return source
    .split('\n')
    .map((line, lineIndex) => {
      const lineLength = line.endsWith('\r') ? line.length - 1 : line.length
      const firstSegment = [
        encodeVlq(0),
        encodeVlq(0),
        encodeVlq(lineIndex - previousOriginalLine),
        encodeVlq(-previousOriginalColumn)
      ].join('')
      previousOriginalLine = lineIndex
      previousOriginalColumn = lineLength
      return `${firstSegment}${',CAAC'.repeat(lineLength)}`
    })
    .join(';')
}

export function rendererIdentitySource(fileName: string): string {
  return `source-map-identity/${basename(fileName)}`
}

export function createRendererIdentitySourceMap(fileName: string, source: string): string {
  return JSON.stringify({
    version: 3,
    file: basename(fileName),
    names: [],
    sources: [rendererIdentitySource(fileName)],
    sourcesContent: [source],
    mappings: identityMappings(source)
  })
}
