#!/usr/bin/env node
// First-touch benchmark for stripTerminalControl, called four times per live PTY chunk.
// Every measured pair uses distinct, output-equivalent inputs and counterbalanced call order.
import { performance } from 'node:perf_hooks'

const ITERATIONS = Number(process.env.ORCA_STRIP_BENCH_ITERATIONS ?? '31')
let resultChecksum = 0
let validatedPairs = 0

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS <= 0) {
  throw new Error(`ORCA_STRIP_BENCH_ITERATIONS must be a positive integer, got ${ITERATIONS}`)
}

function isStrippedCode(code) {
  return (code <= 0x1f && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)
}

function stripPerChar(text) {
  let output = ''
  for (let index = 0; index < text.length; index += 1) {
    if (isStrippedCode(text.charCodeAt(index))) {
      continue
    }
    output += text[index]
  }
  return output
}

function stripSliceRuns(text) {
  let output = ''
  let runStart = 0
  for (let index = 0; index < text.length; index += 1) {
    if (isStrippedCode(text.charCodeAt(index))) {
      if (index > runStart) {
        output += text.slice(runStart, index)
      }
      runStart = index + 1
    }
  }
  return runStart === 0 ? text : output + text.slice(runStart)
}

function makeChunk(lines, controlEvery, strippedControl = '\x07') {
  const line = '  ⏺ Running tests... 42 passed, 0 failed, 3 skipped  \n'
  let text = ''
  for (let index = 0; index < lines; index += 1) {
    text += line
    if (index % controlEvery === 0) {
      text += strippedControl
    }
  }
  return text
}

function makeFixture(lines, controlEvery, sampleId, strippedControl) {
  return `${makeChunk(lines, controlEvery, strippedControl)}${sampleId}`
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function measure(strip, fixture) {
  const start = performance.now()
  const output = strip(fixture)
  return { elapsed: performance.now() - start, output }
}

function consumeOutput(output) {
  resultChecksum = Math.imul(resultChecksum ^ output.length, 16777619) >>> 0
  resultChecksum ^= output.charCodeAt(Math.floor(output.length / 2))
}

function recordPair(lines, controlEvery, sampleId, perCharFirst, samples) {
  const perCharFixture = makeFixture(lines, controlEvery, sampleId, perCharFirst ? '\x01' : '\x02')
  const sliceRunsFixture = makeFixture(
    lines,
    controlEvery,
    sampleId,
    perCharFirst ? '\x02' : '\x01'
  )
  let perCharResult
  let sliceRunsResult
  if (perCharFirst) {
    perCharResult = measure(stripPerChar, perCharFixture)
    sliceRunsResult = measure(stripSliceRuns, sliceRunsFixture)
  } else {
    sliceRunsResult = measure(stripSliceRuns, sliceRunsFixture)
    perCharResult = measure(stripPerChar, perCharFixture)
  }
  if (perCharResult.output !== sliceRunsResult.output) {
    throw new Error(`strip mismatch at ${lines} lines, sample ${sampleId}`)
  }
  consumeOutput(perCharResult.output)
  consumeOutput(sliceRunsResult.output)
  validatedPairs += 1
  samples.perChar.push(perCharResult.elapsed)
  samples.sliceRuns.push(sliceRunsResult.elapsed)
}

const pad = (value, width) => String(value).padStart(width)
console.log('stripTerminalControl, called 4x per PTY chunk. Lower is better.')
console.log(
  `iterations=${ITERATIONS} (${ITERATIONS * 2} first-touch samples/implementation, counterbalanced median)`
)
console.log(
  `${pad('fixture', 22)} ${pad('per-char', 11)} ${pad('slice runs', 12)} ${pad('speedup', 9)}`
)

for (const [lines, controlEvery, label] of [
  [100, 50, 'sparse control'],
  [500, 50, 'sparse control'],
  [500, 5, 'dense control'],
  [2000, 50, 'sparse control']
]) {
  const samples = { perChar: [], sliceRuns: [] }
  for (let index = 0; index < ITERATIONS; index += 1) {
    const orders = index % 2 === 0 ? [true, false] : [false, true]
    for (const perCharFirst of orders) {
      const orderLabel = perCharFirst ? 'per-first' : 'slice-first'
      recordPair(lines, controlEvery, `${index}:${orderLabel}`, perCharFirst, samples)
    }
  }
  const sizeKb = (makeChunk(lines, controlEvery).length / 1024).toFixed(0)
  const perChar = median(samples.perChar)
  const sliceRuns = median(samples.sliceRuns)
  console.log(
    `${pad(`${lines} lines ${label}`, 22)} ${pad(`${(perChar * 1000).toFixed(1)} us`, 11)} ${pad(`${(sliceRuns * 1000).toFixed(1)} us`, 12)} ${pad(`${(perChar / sliceRuns).toFixed(2)}x`, 9)} (${sizeKb} KiB)`
  )
}
console.log(`\nvalidated=${validatedPairs} measured pairs, result checksum=${resultChecksum >>> 0}`)
console.log(
  'The detector pays this cost four times per PTY write once a Command Code pane is live.'
)
