const BASE64_VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const BASE64_VLQ_VALUES = new Int8Array(128)
BASE64_VLQ_VALUES.fill(-1)
for (const [value, character] of [...BASE64_VLQ].entries()) {
  BASE64_VLQ_VALUES[character.charCodeAt(0)] = value
}

function decodeVlqSegment(encoded, mapLabel, lineIndex, segmentIndex) {
  if (encoded.length === 0) {
    throw new Error(`${mapLabel} has an empty VLQ segment at ${lineIndex}:${segmentIndex}`)
  }
  const fields = []
  let value = 0
  let shift = 0
  for (const character of encoded) {
    const characterCode = character.charCodeAt(0)
    const digit = characterCode < BASE64_VLQ_VALUES.length ? BASE64_VLQ_VALUES[characterCode] : -1
    if (digit < 0) {
      throw new Error(`${mapLabel} has an invalid VLQ character at ${lineIndex}:${segmentIndex}`)
    }
    value += (digit & 31) * 2 ** shift
    if (!Number.isSafeInteger(value)) {
      throw new Error(`${mapLabel} has an overflowing VLQ value at ${lineIndex}:${segmentIndex}`)
    }
    if (digit & 32) {
      shift += 5
      continue
    }
    const magnitude = Math.floor(value / 2)
    fields.push(value & 1 ? -magnitude : magnitude)
    value = 0
    shift = 0
  }
  if (shift !== 0) {
    throw new Error(`${mapLabel} has a truncated VLQ value at ${lineIndex}:${segmentIndex}`)
  }
  return fields
}

function assertOriginalPosition(
  sourceMap,
  sourceLines,
  sourceIndex,
  line,
  column,
  mapLabel,
  location
) {
  if (sourceIndex < 0 || sourceIndex >= sourceMap.sources.length || line < 0 || column < 0) {
    throw new Error(`${mapLabel} has invalid source position at ${location}`)
  }
  const lines = sourceLines?.[sourceIndex]
  if (!lines) {
    return
  }
  const sourceLine = lines[line]
  if (sourceLine === undefined || column > sourceLine.length) {
    throw new Error(`${mapLabel} has out-of-range original position at ${location}`)
  }
}

function verifyBasicMappingsStrict(sourceMap, decoded, mapLabel) {
  const sourceLines = sourceMap.sourcesContent?.map((content) =>
    typeof content === 'string' ? content.split('\n').map((line) => line.replace(/\r$/, '')) : null
  )
  let sourceIndex = 0
  let originalLine = 0
  let originalColumn = 0
  let nameIndex = 0
  for (const [lineIndex, encodedLine] of sourceMap.mappings.split(';').entries()) {
    const decodedLine = decoded[lineIndex]
    if (!Array.isArray(decodedLine)) {
      throw new Error(`${mapLabel} is normalized differently by the symbolication library`)
    }
    let generatedColumn = 0
    let segmentCount = 0
    if (encodedLine !== '') {
      encodedLine.split(',').forEach((encodedSegment, segmentIndex) => {
        segmentCount += 1
        const fields = decodeVlqSegment(encodedSegment, mapLabel, lineIndex, segmentIndex)
        if (![1, 4, 5].includes(fields.length)) {
          throw new Error(`${mapLabel} has invalid decoded segment ${lineIndex}:${segmentIndex}`)
        }
        generatedColumn += fields[0]
        if (!Number.isSafeInteger(generatedColumn) || generatedColumn < 0) {
          throw new Error(
            `${mapLabel} has invalid generated column at ${lineIndex}:${segmentIndex}`
          )
        }
        const segment = [generatedColumn]
        if (fields.length > 1) {
          sourceIndex += fields[1]
          originalLine += fields[2]
          originalColumn += fields[3]
          const location = `${lineIndex}:${segmentIndex}`
          assertOriginalPosition(
            sourceMap,
            sourceLines,
            sourceIndex,
            originalLine,
            originalColumn,
            mapLabel,
            location
          )
          segment.push(sourceIndex, originalLine, originalColumn)
          if (fields.length === 5) {
            nameIndex += fields[4]
            if (nameIndex < 0 || nameIndex >= sourceMap.names.length) {
              throw new Error(`${mapLabel} has invalid name index at ${location}`)
            }
            segment.push(nameIndex)
          }
        }
        const librarySegment = decodedLine[segmentIndex]
        if (
          !Array.isArray(librarySegment) ||
          librarySegment.length !== segment.length ||
          librarySegment.some((value, index) => value !== segment[index])
        ) {
          throw new Error(`${mapLabel} is normalized differently by the symbolication library`)
        }
      })
    }
    if (decodedLine.length !== segmentCount) {
      throw new Error(`${mapLabel} is normalized differently by the symbolication library`)
    }
  }
  if (decoded.length !== sourceMap.mappings.split(';').length) {
    throw new Error(`${mapLabel} is normalized differently by the symbolication library`)
  }
}

module.exports = { verifyBasicMappingsStrict }
