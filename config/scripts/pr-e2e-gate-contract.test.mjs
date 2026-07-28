import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

const projectDir = resolve(import.meta.dirname, '../..')
const prWorkflow = parse(readFileSync(join(projectDir, '.github/workflows/pr.yml'), 'utf8'))

const filterStep = prWorkflow.jobs['e2e-paths'].steps.find(
  (step) => step.name === 'Filter E2E-relevant paths'
)
const verifyStep = prWorkflow.jobs.verify.steps.find(
  (step) => step.name === 'Require successful checks'
)

describe('PR E2E gate contract', () => {
  it('blocks the merge gate on E2E instead of only displaying it', () => {
    // Why: an e2e job that verify does not depend on reproduces the bug this
    // gate exists to fix — a red spec still merges because verify stays green.
    expect(prWorkflow.jobs.verify.needs).toContain('e2e')
    expect(verifyStep.env.E2E).toBe('${{ needs.e2e.result }}')
    expect(verifyStep.run).toContain('"$E2E" != "success"')
  })

  it('treats a path-filtered skip as passing without excusing the other jobs', () => {
    // Why: E2E is skipped on PRs touching no E2E files, so 'skipped' must pass.
    // The always-required jobs are checked in their own loop so that allowance
    // cannot leak to them.
    expect(verifyStep.run).toContain('"$E2E" != "skipped"')

    const strictLoop = verifyStep.run.slice(0, verifyStep.run.indexOf('done'))
    for (const required of ['STATIC_ANALYSIS', 'TYPECHECK', 'TEST', 'PACKAGE']) {
      expect(strictLoop).toContain(`"$${required}"`)
    }
    expect(strictLoop).not.toContain('$E2E')
  })

  it('matches the Playwright config where it actually lives', () => {
    // Why: the config is tests/playwright.config.ts, beside tests/e2e/ rather
    // than inside it. A bare `playwright.` prefix matches no tracked file, so
    // editing the runner config would silently skip E2E.
    expect(filterStep.run).toContain('tests/playwright\\.')
    expect(filterStep.run).not.toMatch(/\(\^?\|\|]tests\/e2e\/\|playwright\\\./)
  })

  it('scopes detection to the PR range so base drift cannot false-trigger', () => {
    expect(filterStep.run).toContain('git diff --name-only --merge-base "$BASE" "$HEAD"')
    expect(filterStep.run).toContain('set -euo pipefail')
  })
})
