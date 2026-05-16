import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'

/** Temp file where the test repo path is stored for the fixture to read. */
export const TEST_REPO_PATH_FILE = path.join(os.tmpdir(), 'orca-e2e-test-repo-path.txt')

export type SeededTestRepo = {
  repoDir: string
  secondaryWorktreeDir: string
}

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8'
  })
}

export function isValidGitRepo(repoPath: string): boolean {
  if (!repoPath || !existsSync(repoPath)) {
    return false
  }

  try {
    return runGit(repoPath, ['rev-parse', '--is-inside-work-tree']).trim() === 'true'
  } catch {
    return false
  }
}

export function createSeededTestRepo(): SeededTestRepo {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-repo-'))

  runGit(repoDir, ['init'])
  runGit(repoDir, ['config', 'user.email', 'e2e@test.local'])
  runGit(repoDir, ['config', 'user.name', 'E2E Test'])

  writeFileSync(
    path.join(repoDir, 'README.md'),
    '# Orca E2E Test Repo\n\nThis repo was created automatically for Playwright tests.\n'
  )
  writeFileSync(path.join(repoDir, 'CLAUDE.md'), '# CLAUDE.md\n\nTest instructions for E2E.\n')
  writeFileSync(
    path.join(repoDir, 'package.json'),
    `${JSON.stringify({ name: 'orca-e2e-test', version: '0.0.0', private: true }, null, 2)}\n`
  )
  writeFileSync(path.join(repoDir, '.gitignore'), 'node_modules/\n')
  mkdirSync(path.join(repoDir, 'src'), { recursive: true })
  writeFileSync(path.join(repoDir, 'src', 'index.ts'), 'export const hello = "world"\n')

  runGit(repoDir, ['add', '-A'])
  runGit(repoDir, ['commit', '-m', 'Initial commit for E2E tests'])

  // Why: worker-scoped fixture fallbacks can run in parallel; UUIDs avoid
  // colliding on the same temp repo/worktree when workers start together.
  const secondaryWorktreeDir = path.join(repoDir, '..', `orca-e2e-worktree-${randomUUID()}`)
  runGit(repoDir, ['worktree', 'add', '-b', 'e2e-secondary', secondaryWorktreeDir])

  writeFileSync(TEST_REPO_PATH_FILE, repoDir)
  return { repoDir, secondaryWorktreeDir }
}
