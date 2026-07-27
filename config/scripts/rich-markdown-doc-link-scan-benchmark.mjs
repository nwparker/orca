#!/usr/bin/env node
// Benchmark: the doc-link text-node walk that runs on every editor transaction.
//
// Two ProseMirror plugins in rich-markdown-doc-link.ts walk every text node and
// run `matchAll(/\[\[([^[\]\r\n]+)\]\]/g)` on each: the auto-convert plugin's
// appendTransaction (once per keystroke) and the inline-preview decoration
// rebuild (once per keystroke AND once per caret move).
//
// A doc link needs a literal `[[`, so a native substring check skips both the
// regex iterator and the parent code-context check for every text node that
// cannot match — which is nearly all of them in ordinary prose.
//
// Fixture is real repo markdown in on-disk order, split into paragraph-sized
// text nodes. Both arms are compared for identical match counts before timing,
// so a gate that skipped a real match could not be reported as a win.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ITERATIONS = Number(process.env.ORCA_DOC_LINK_BENCH_ITERATIONS ?? '41')

if (!Number.isSafeInteger(ITERATIONS) || ITERATIONS <= 0) {
  throw new Error(`ORCA_DOC_LINK_BENCH_ITERATIONS must be a positive integer, got ${ITERATIONS}`)
}

// Mirrors the pattern in rich-markdown-doc-link.ts.
const DOC_LINK_PATTERN = /\[\[([^[\]\r\n]+)\]\]/g
const DOC_LINK_OPEN = '[['

// Pre-fix: matchAll on every text node.
function walkUngated(textNodes) {
  let matches = 0
  for (const text of textNodes) {
    for (const _match of text.matchAll(DOC_LINK_PATTERN)) {
      matches += 1
    }
  }
  return matches
}

// Post-fix: skip nodes that cannot contain a link.
function walkGated(textNodes) {
  let matches = 0
  for (const text of textNodes) {
    if (!text.includes(DOC_LINK_OPEN)) {
      continue
    }
    for (const _match of text.matchAll(DOC_LINK_PATTERN)) {
      matches += 1
    }
  }
  return matches
}

function loadDocs() {
  const files = execFileSync('git', ['ls-files', '*.md', 'docs/*.md'], {
    cwd: REPO_ROOT,
    maxBuffer: 256 * 1024 * 1024
  })
    .toString()
    .split('\n')
    .filter(Boolean)
  const docs = []
  for (const file of files) {
    try {
      // Paragraph-ish split approximates ProseMirror's text nodes.
      const nodes = readFileSync(`${REPO_ROOT}/${file}`, 'utf8').split('\n').filter(Boolean)
      if (nodes.length > 0) {
        docs.push({ file, nodes })
      }
    } catch {
      // A path in the index that is not readable here is simply skipped.
    }
  }
  return docs
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

// First-touch: one bracket per never-before-walked node array, so V8 cannot hoist
// the call out of a timing loop.
function measure(walk, docs) {
  const samples = []
  for (let index = 0; index < ITERATIONS; index += 1) {
    const doc = docs[index % docs.length]
    const start = performance.now()
    walk(doc.nodes)
    samples.push(performance.now() - start)
  }
  return median(samples)
}

const docs = loadDocs()
if (docs.length === 0) {
  throw new Error('no markdown files found in the index')
}
for (const doc of docs) {
  if (walkUngated(doc.nodes) !== walkGated(doc.nodes)) {
    throw new Error(`gate changed the match count for ${doc.file}`)
  }
}

const large = docs.filter((doc) => doc.nodes.join('\n').length > 3000)
const biggest = docs.reduce((a, b) =>
  b.nodes.join('\n').length > a.nodes.join('\n').length ? b : a
)

const pad = (value, width) => String(value).padStart(width)
console.log('Doc-link text-node walk, per editor transaction. Lower is better.')
console.log(
  `docs=${docs.length} (>3KB: ${large.length}) iterations=${ITERATIONS} (first-touch, median)`
)
console.log(`${pad('corpus', 26)} ${pad('ungated', 11)} ${pad('gated', 11)} ${pad('speedup', 9)}`)

for (const [label, set] of [
  ['all repo markdown', docs],
  ['docs over 3 KB', large],
  [`biggest (${biggest.file.split('/').pop()})`, [biggest]]
]) {
  const ungated = measure(walkUngated, set)
  const gated = measure(walkGated, set)
  console.log(
    `${pad(label, 26)} ${pad(`${(ungated * 1000).toFixed(1)} us`, 11)} ${pad(`${(gated * 1000).toFixed(1)} us`, 11)} ${pad(`${(ungated / gated).toFixed(1)}x`, 9)}`
  )
}
console.log(
  '\nThis fires once per keystroke for the auto-convert plugin and once per\nkeystroke plus once per caret move for the preview decorations, so the cost is\npaid on the editor typing path rather than on an occasional refresh.'
)
