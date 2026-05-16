#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const projectRoot = process.cwd()
const manifestPath = resolve(projectRoot, 'tests/regression-coverage-manifest.json')
const coverageSummaryPath = resolve(projectRoot, 'coverage/coverage-summary.json')

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function hasRealTest(path) {
  if (!existsSync(path)) {
    return false
  }
  const contents = readFileSync(path, 'utf8')
  return /\b(?:test|it)\s*\(/.test(contents)
}

function printMetric(label, value) {
  console.log(`${label.padEnd(31)} ${value}`)
}

if (!existsSync(manifestPath)) {
  console.error(`Missing regression coverage manifest: ${relative(projectRoot, manifestPath)}`)
  process.exitCode = 1
  process.exit()
}

const manifest = readJson(manifestPath)
const surfaces = Array.isArray(manifest.surfaces) ? manifest.surfaces : []
const measured = surfaces.map((surface) => {
  const files = Array.isArray(surface.coveredBy) ? surface.coveredBy : []
  const validFiles = files.filter((file) => hasRealTest(resolve(projectRoot, file)))
  return {
    ...surface,
    validFiles,
    covered: validFiles.length > 0
  }
})

const coveredCount = measured.filter((surface) => surface.covered).length
const totalCount = measured.length
const surfacePct = totalCount === 0 ? 100 : (coveredCount / totalCount) * 100
const uncovered = measured.filter((surface) => !surface.covered)

console.log('Regression coverage report')
console.log('')
printMetric('Manifest', relative(projectRoot, manifestPath))
printMetric('Regression surfaces', `${coveredCount}/${totalCount} (${surfacePct.toFixed(2)}%)`)

if (existsSync(coverageSummaryPath)) {
  const coverage = readJson(coverageSummaryPath).total
  printMetric(
    'Vitest line coverage',
    `${coverage.lines.pct.toFixed(2)}% (${coverage.lines.covered}/${coverage.lines.total})`
  )
  printMetric(
    'Vitest branch coverage',
    `${coverage.branches.pct.toFixed(2)}% (${coverage.branches.covered}/${coverage.branches.total})`
  )
  printMetric(
    'Vitest function coverage',
    `${coverage.functions.pct.toFixed(2)}% (${coverage.functions.covered}/${coverage.functions.total})`
  )
} else {
  printMetric('Vitest coverage summary', 'not found; run pnpm run coverage first')
}

console.log('')
console.log('Covered surfaces')
for (const surface of measured.filter((entry) => entry.covered)) {
  console.log(`- ${surface.id}: ${surface.validFiles.join(', ')}`)
}

if (uncovered.length > 0) {
  console.log('')
  console.log('Known uncovered surfaces')
  for (const surface of uncovered) {
    console.log(`- ${surface.id}: ${surface.title}`)
  }
}

if (surfacePct < 90) {
  console.error(`\nRegression surface coverage is below target: ${surfacePct.toFixed(2)}% < 90%`)
  process.exitCode = 1
}
