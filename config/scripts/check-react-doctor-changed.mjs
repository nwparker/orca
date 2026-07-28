import { spawnSync } from 'node:child_process'
import process from 'node:process'

const base =
  process.argv.slice(2).find((argument) => argument !== '--') ??
  process.env.ORCA_CODE_QUALITY_BASE ??
  'origin/main'
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const result = spawnSync(
  pnpm,
  [
    'exec',
    'react-doctor',
    '.',
    '--yes',
    '--scope',
    'lines',
    '--base',
    base,
    '--include-untracked',
    '--no-dead-code',
    '--no-supply-chain',
    '--no-telemetry',
    '--blocking',
    'error'
  ],
  { stdio: 'inherit' }
)

if (result.error) {
  throw result.error
}
process.exit(result.status ?? 1)
