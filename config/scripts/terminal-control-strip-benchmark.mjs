#!/usr/bin/env node
// Benchmark: stripTerminalControl, which runs four times per PTY chunk.
//
// createCommandCodeOutputStatusDetector calls it on the combined scan text, the
// chunk-boundary variant, and both previous-text lengths — every chunk, once the
// Command Code UI has been seen. It built its result with a per-character `+=`
// append, which allocates a fresh string per retained character.
//
// Control bytes are sparse in real agent output, so copying the spans between
// them is far cheaper. Both arms are compared on every fixture before timing.
import { performance } from 'node:perf_hooks'

const ITERATIONS = Number(process.env.ORCA_STRIP_BENCH_ITERATIONS ?? '31')

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS <= 0) {
  throw new Error(`ORCA_STRIP_BENCH_ITERATIONS must be a positive integer, got ${ITERATIONS}`)
}

function isStrippedCode(code) {
  return (code <= 0x1f && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)
}

// Pre-fix: append one character at a time.
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

// Post-fix: copy the runs between control bytes.
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

// Agent TUI output: mostly printable, with control bytes sprinkled through.
function makeChunk(lines, controlEvery) {
  const line = '  ⏺ Running tests... 42 passed, 0 failed, 3 skipped  \n'
  let text = ''
  for (let index = 0; index < lines; index += 1) {
    text += line
    if (index % controlEvery === 0) {
      text += ''
    }
  }
  return text
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// First-touch: one bracket per never-before-stripped string, so V8 cannot hoist
// the call out of a timing loop.
function measure(strip, fixtures) {
  const samples = []
  for (const fixture of fixtures) {
    const start = performance.now()
    strip(fixture)
    samples.push(performance.now() - start)
  }
  return median(samples)
}

const pad = (value, width) => String(value).padStart(width)
console.log('stripTerminalControl, called 4x per PTY chunk. Lower is better.')
console.log(`iterations=${ITERATIONS} (first-touch, median)`)
console.log(
  `${pad('fixture', 22)} ${pad('per-char', 11)} ${pad('slice runs', 12)} ${pad('speedup', 9)}`
)

for (const [lines, controlEvery, label] of [
  [100, 50, 'sparse control'],
  [500, 50, 'sparse control'],
  [500, 5, 'dense control'],
  [2000, 50, 'sparse control']
]) {
  // Distinct string instances so no fixture is timed twice.
  const fixtures = Array.from(
    { length: ITERATIONS },
    (_value, index) => `${makeChunk(lines, controlEvery)}${index}`
  )
  for (const fixture of fixtures.slice(0, 3)) {
    if (stripPerChar(fixture) !== stripSliceRuns(fixture)) {
      throw new Error(`strip mismatch at ${lines} lines`)
    }
  }
  const sizeKb = (fixtures[0].length / 1024).toFixed(0)
  const perChar = measure(stripPerChar, fixtures)
  const sliceRuns = measure(stripSliceRuns, fixtures)
  console.log(
    `${pad(`${lines} lines ${label}`, 22)} ${pad(`${(perChar * 1000).toFixed(1)} us`, 11)} ${pad(`${(sliceRuns * 1000).toFixed(1)} us`, 12)} ${pad(`${(perChar / sliceRuns).toFixed(2)}x`, 9)} (${sizeKb} KiB)`
  )
}
console.log(
  '\nThe detector strips the scan text, the chunk-boundary variant, and both\nprevious-text lengths on every chunk, so this cost is paid four times per\nPTY write once a Command Code pane is live.'
)
