#!/usr/bin/env node
// Benchmark: cost of resolving a Command Code turn prompt from the transcript,
// paid on EVERY command-code hook event (PreToolUse/PostToolUse fire once per
// tool call, so many per second during an active agent turn).
//
// Before the fix, readLastCommandCodeUserPromptEntryFromTranscript() read up to
// TRANSCRIPT_MAX_SCAN_BYTES (4 MB) synchronously, decoded it all to a JS string,
// and JSON-parsed EVERY line to the end of the buffer to find the LAST user
// entry — so cost grew with the transcript, which only grows as a session runs.
//
// The fix scans backward from EOF in TRANSCRIPT_CHUNK_BYTES blocks and returns
// on the first user line, the shape the sibling readLastTextFromTranscriptOnce
// already used. The answer sits near EOF in a real session (the current turn's
// prompt precedes only this turn's output), so the scan reads one or two blocks
// instead of the whole file.
//
// Both implementations are mirrored here: node cannot import the .ts source,
// matching the other benchmarks in this directory. Constants are re-read from
// the real module so a drifted cap fails loudly instead of measuring dead code.
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const LISTENER_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/shared/agent-hook-listener.ts', import.meta.url)),
  'utf8'
)

function readMirroredConstant(name) {
  const match = LISTENER_SOURCE.match(new RegExp(`const ${name} = ([^\\n]+)`))
  if (!match) {
    throw new Error(`agent-hook-listener.ts no longer defines ${name}; re-sync this benchmark.`)
  }
  const value = Number(new Function(`return (${match[1]})`)())
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} did not resolve to a positive integer`)
  }
  return value
}

const TRANSCRIPT_CHUNK_BYTES = readMirroredConstant('TRANSCRIPT_CHUNK_BYTES')
const TRANSCRIPT_MAX_SCAN_BYTES = readMirroredConstant('TRANSCRIPT_MAX_SCAN_BYTES')
const ITERATIONS = Number.parseInt(process.env.ORCA_CC_SCAN_BENCH_ITERATIONS ?? '150', 10)
const WARMUP = Number.parseInt(process.env.ORCA_CC_SCAN_BENCH_WARMUP ?? '20', 10)

for (const [name, value] of [
  ['ORCA_CC_SCAN_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_CC_SCAN_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

function extractUserPrompt(line) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return undefined
  }
  if (typeof entry !== 'object' || entry === null || entry.role !== 'user') {
    return undefined
  }
  const content = entry.content
  if (typeof content === 'string' && content.trim().length > 0) {
    return content
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'object' && part !== null) {
        const text = part.text
        if (typeof text === 'string' && text.trim().length > 0) {
          return text
        }
      }
    }
  }
  return undefined
}

// Pre-fix: read the capped window, then parse every line to the end.
function readForward(path) {
  const size = statSync(path).size
  if (size <= 0) {
    return undefined
  }
  const bytesToRead = Math.min(size, TRANSCRIPT_MAX_SCAN_BYTES)
  const position = size - bytesToRead
  const fd = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(bytesToRead)
    let filled = 0
    while (filled < bytesToRead) {
      const n = readSync(fd, buffer, filled, bytesToRead - filled, position + filled)
      if (n === 0) {
        break
      }
      filled += n
    }
    let text = buffer.subarray(0, filled).toString('utf8')
    if (position > 0) {
      const firstNewline = text.indexOf('\n')
      text = firstNewline === -1 ? '' : text.slice(firstNewline + 1)
    }
    let last
    for (const line of text.split('\n')) {
      const prompt = extractUserPrompt(line.trim())
      if (prompt !== undefined) {
        last = prompt
      }
    }
    return last
  } finally {
    closeSync(fd)
  }
}

function findLastPromptInRegion(region) {
  let lineEnd = region.length
  for (let index = region.length - 1; index >= -1; index--) {
    if (index >= 0 && region[index] !== 0x0a) {
      continue
    }
    const lineStart = index + 1
    if (lineEnd > lineStart) {
      const prompt = extractUserPrompt(region.subarray(lineStart, lineEnd).toString('utf8').trim())
      if (prompt !== undefined) {
        return prompt
      }
    }
    lineEnd = index
  }
  return undefined
}

// Post-fix: walk backward from EOF, return on the first user line.
function readBackward(path) {
  const size = statSync(path).size
  if (size <= 0) {
    return undefined
  }
  const fd = openSync(path, 'r')
  try {
    let carryBytes = Buffer.alloc(0)
    let bytesRead = 0
    while (bytesRead < size && bytesRead < TRANSCRIPT_MAX_SCAN_BYTES) {
      const chunkSize = Math.min(
        size - bytesRead,
        TRANSCRIPT_CHUNK_BYTES,
        TRANSCRIPT_MAX_SCAN_BYTES - bytesRead
      )
      const position = size - bytesRead - chunkSize
      const buffer = Buffer.alloc(chunkSize)
      let filled = 0
      while (filled < chunkSize) {
        const n = readSync(fd, buffer, filled, chunkSize - filled, position + filled)
        if (n === 0) {
          break
        }
        filled += n
      }
      if (filled === 0) {
        break
      }
      bytesRead += filled
      const combined = Buffer.concat([buffer.subarray(0, filled), carryBytes])
      const atStart = bytesRead >= size
      const firstNewline = combined.indexOf(0x0a)
      let completeRegion
      if (atStart) {
        completeRegion = combined
        carryBytes = Buffer.alloc(0)
      } else if (firstNewline === -1) {
        completeRegion = Buffer.alloc(0)
        carryBytes = combined
      } else {
        completeRegion = combined.subarray(firstNewline + 1)
        carryBytes = combined.subarray(0, firstNewline)
      }
      if (completeRegion.length > 0) {
        const found = findLastPromptInRegion(completeRegion)
        if (found !== undefined) {
          return found
        }
      }
    }
    return undefined
  } finally {
    closeSync(fd)
  }
}

// A real session: many completed turns, then THIS turn's prompt, then the tool
// output produced since. The prompt therefore sits near EOF.
function writeTranscript(path, priorTurns) {
  const lines = []
  for (let index = 0; index < priorTurns; index += 1) {
    lines.push(
      JSON.stringify({ role: 'user', content: [{ type: 'text', text: `older turn ${index}` }] })
    )
    lines.push(
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: `${'assistant output '.repeat(30)}${index}` }]
      })
    )
  }
  lines.push(
    JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'the current prompt' }] })
  )
  for (let index = 0; index < 40; index += 1) {
    lines.push(
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: `${'current turn output '.repeat(30)}${index}` }]
      })
    )
  }
  writeFileSync(path, `${lines.join('\n')}\n`)
}

function measure(fn, path) {
  for (let index = 0; index < WARMUP; index += 1) {
    fn(path)
  }
  const samples = []
  for (let round = 0; round < 3; round += 1) {
    const start = performance.now()
    for (let index = 0; index < ITERATIONS; index += 1) {
      fn(path)
    }
    samples.push((performance.now() - start) / ITERATIONS)
  }
  samples.sort((a, b) => a - b)
  return samples[1]
}

const dir = mkdtempSync(join(tmpdir(), 'orca-cc-transcript-bench-'))
try {
  const rows = []
  for (const priorTurns of [250, 1000, 3000, 6000]) {
    const path = join(dir, `transcript-${priorTurns}.jsonl`)
    writeTranscript(path, priorTurns)
    const forward = readForward(path)
    const backward = readBackward(path)
    if (forward !== backward) {
      throw new Error(`prompt mismatch at ${priorTurns} prior turns: ${forward} vs ${backward}`)
    }
    if (backward !== 'the current prompt') {
      throw new Error(`benchmark fixture resolved the wrong prompt: ${backward}`)
    }
    rows.push({
      sizeMb: statSync(path).size / (1024 * 1024),
      beforeMs: measure(readForward, path),
      afterMs: measure(readBackward, path)
    })
  }

  const pad = (value, width) => String(value).padStart(width)
  console.log('Command Code transcript prompt read, per hook event')
  console.log(`iterations=${ITERATIONS} warmup=${WARMUP} (median of 3 rounds)`)
  console.log(
    `${pad('size', 9)} ${pad('before ms', 11)} ${pad('after ms', 10)} ${pad('speedup', 9)}`
  )
  for (const row of rows) {
    console.log(
      `${pad(`${row.sizeMb.toFixed(2)} MB`, 9)} ${pad(row.beforeMs.toFixed(3), 11)} ${pad(row.afterMs.toFixed(3), 10)} ${pad(`${(row.beforeMs / row.afterMs).toFixed(0)}x`, 9)}`
    )
  }
  console.log(
    '\nThe old cost grows with the transcript; the new cost is flat because the\ncurrent turn’s prompt sits near EOF and the scan stops at the first hit.'
  )
} finally {
  rmSync(dir, { recursive: true, force: true })
}
