import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')

function buildSteps() {
  return parse(readFileSync(join(projectDir, '.github/workflows/release-cut.yml'), 'utf8')).jobs
    .build.steps
}

describe('release-cut source map publication', () => {
  it('bundles and uploads main source maps from exactly one platform leg', () => {
    const steps = buildSteps()
    const bundle = steps.find((step) => step.name === 'Bundle main-process source maps')
    const publish = steps.find((step) => step.name === 'Publish main-process source maps')

    // Why: the main bundle is platform-independent, so duplicating the ~8MB
    // artifact across legs would only race the uploads against each other.
    for (const step of [bundle, publish]) {
      expect(step).toBeDefined()
      expect(step.if).toBe("matrix.platform == 'linux-x64'")
    }

    expect(bundle.run).toContain("find out/main -name '*.js.map'")
    expect(publish.with.command).toContain('gh release upload')
    expect(publish.with.command).toContain('orca-sourcemaps-')
  })

  it('fails the release when no source maps were emitted', () => {
    // Why: a silent regression of build.sourcemap would ship an undecodable
    // release rather than an obviously broken one.
    const bundle = buildSteps().find((step) => step.name === 'Bundle main-process source maps')
    expect(bundle.run).toContain('::error::')
    expect(bundle.run).toContain('exit 1')
  })

  it('bundles maps before packaging strips them', () => {
    const names = buildSteps().map((step) => step.name)
    expect(names.indexOf('Bundle main-process source maps')).toBeGreaterThan(
      names.indexOf('Build app')
    )
    expect(names.indexOf('Bundle main-process source maps')).toBeLessThan(
      names.indexOf('Publish release artifacts (Linux)')
    )
  })
})
