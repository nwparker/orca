/**
 * Playwright globalSetup: builds the Electron app and creates a test git repo.
 *
 * Why: _electron.launch() needs the compiled output in out/main/index.js.
 * Running electron-vite build here ensures the tests are always against
 * the current source, without requiring the user to remember a manual step.
 *
 * Why: a dedicated test repo makes the suite idempotent — tests don't
 * depend on whatever the user has open. The repo path is written to a
 * temp file so the worker fixture can pick it up at runtime.
 */

import { execFileSync } from 'child_process'
import { existsSync } from 'fs'
import path from 'path'
import { createSeededTestRepo } from './helpers/seeded-git-repo'

function executableName(command: string): string {
  return process.platform === 'win32' ? `${command}.cmd` : command
}

export default function globalSetup(): void {
  const root = process.cwd()
  const outMain = path.join(root, 'out', 'main', 'index.js')

  // ── 1. Build the Electron app ──────────────────────────────────────
  if (process.env.SKIP_BUILD && existsSync(outMain)) {
    console.log('[e2e] SKIP_BUILD set and out/main/index.js exists — skipping build')
  } else {
    // Why: --mode e2e loads .env.e2e which sets VITE_EXPOSE_STORE=true. This
    // makes window.__store available in the renderer build so tests can read
    // Zustand state directly instead of fragile DOM scraping.
    const sourcemapArgs = process.env.ORCA_E2E_COVERAGE_DIR ? ['--sourcemap'] : []
    console.log(
      `[e2e] Building Electron app with electron-vite build --mode e2e${sourcemapArgs.length > 0 ? ' --sourcemap' : ''}...`
    )
    // Why: pass args directly instead of through a shell so the setup command
    // works in temp paths containing spaces and on Windows' cmd.exe.
    execFileSync(
      executableName('npx'),
      ['electron-vite', 'build', '--mode', 'e2e', ...sourcemapArgs],
      {
        cwd: root,
        stdio: 'inherit',
        timeout: 120_000
      }
    )
    console.log('[e2e] Build complete.')
  }
  if (process.env.ORCA_E2E_SSH_LOCALHOST === '1') {
    // Why: the localhost SSH spec deploys Orca's relay from out/relay. The
    // normal Electron E2E build does not produce that bundle, so build it only
    // for the explicit local-machine SSH run.
    console.log('[e2e] Building SSH relay bundle for localhost SSH E2E...')
    execFileSync(executableName('pnpm'), ['run', 'build:relay'], {
      cwd: root,
      stdio: 'inherit',
      timeout: 120_000
    })
  }

  // ── 2. Create a seeded test git repo ───────────────────────────────
  // Why: each test run gets its own git repo so the suite is fully
  // idempotent. No test depends on whatever repos the user has open.
  const { repoDir, secondaryWorktreeDir } = createSeededTestRepo()
  console.log(`[e2e] Secondary worktree created at ${secondaryWorktreeDir}`)
  console.log(`[e2e] Test repo created at ${repoDir}`)
}
