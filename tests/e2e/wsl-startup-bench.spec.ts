/**
 * D3 startup gate bench (local only, not for merge): time from app launch to a usable WSL terminal,
 * bridge vs WSL host, on one persistent profile per mode.
 *   D3_MODE=bridge|host D3_STEP=setup|cold|warm D3_PROFILE=<dir> D3_DISTRO=<name> D3_RUNS=<n>
 *   D3_OUT=<jsonl> [ORCA_ORCAD_TEMPLATE_PATH=<dir> for host]
 */
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  _electron as electron,
  test,
  type ElectronApplication,
  type Page
} from '@stablyai/playwright-test'
import { runProcess } from '@orca/process-host'
import { buildWslExecArgs } from '../../src/shared/wsl-login-shell-command'
import { getE2ECompletedOnboardingProfile } from './helpers/e2e-completed-onboarding-profile'
import { getOrcaElectronLaunchArgs } from './helpers/electron-launch-args'
import { cleanupE2EDaemons, closeElectronAppForE2E } from './helpers/electron-process-shutdown'
import { createElectronHomeIsolation } from './helpers/electron-home-isolation'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'

const MODE = process.env.D3_MODE ?? 'bridge'
const STEP = process.env.D3_STEP ?? 'warm'
const PROFILE = process.env.D3_PROFILE ?? ''
const DISTRO = process.env.D3_DISTRO ?? 'orca-d3-sd'
const RUNS = Number(process.env.D3_RUNS ?? '1')
const OUT = process.env.D3_OUT ?? path.join(PROFILE, '..', 'd3-results.jsonl')
const PROJECT = MODE === 'host' ? 'hproj' : 'bproj'
const GUEST_PROJECT = `/home/orca/${PROJECT}`
const ENV_ID = `wsl:${DISTRO.toLowerCase()}`

async function wsl(args: string[], timeoutMs = 120_000): Promise<string> {
  const result = await runProcess({
    program: 'wsl.exe',
    args,
    timeoutMs,
    env: { ...process.env, WSL_UTF8: '1' }
  })
  return `${result.stdout ?? ''}`
}

async function distroRunning(): Promise<boolean> {
  const out = await wsl(['--list', '--running', '--quiet'])
  return out
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim().toLowerCase())
    .includes(DISTRO.toLowerCase())
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; t0: number; log: string[] }> {
  if (!existsSync(path.join(PROFILE, 'orca-data.json'))) {
    mkdirSync(PROFILE, { recursive: true })
    writeFileSync(
      path.join(PROFILE, 'orca-data.json'),
      `${JSON.stringify(getE2ECompletedOnboardingProfile(), null, 2)}\n`
    )
  }
  const { ELECTRON_RUN_AS_NODE: _unused, ...cleanEnv } = process.env
  void _unused
  const isolation = createElectronHomeIsolation({
    inheritedEnv: cleanEnv,
    launchEnv: {},
    extraEnv: {
      ORCA_STARTUP_DIAGNOSTICS: '1',
      ...(MODE === 'host' ? { ORCA_INTERNAL_WSL_HOSTS: '1' } : {})
    },
    userDataDir: PROFILE
  })
  const log: string[] = []
  const t0 = Date.now()
  const app = await electron.launch({
    args: getOrcaElectronLaunchArgs(path.join(process.cwd(), 'out', 'main', 'index.js'), false),
    env: { ...isolation.env, NODE_ENV: 'development', ORCA_E2E_HEADLESS: '1' }
  })
  app.process().stderr?.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line.includes('[startup]') || line.includes('[wsl-hosts]')) {
        log.push(`${Date.now() - t0} ${line}`)
      }
    }
  })
  const page = await app.firstWindow({ timeout: 120_000 })
  page.on('console', (message) => {
    const text = message.text()
    if (text.startsWith('[d3r]')) {
      const [, at, ...rest] = text.split(' ')
      log.push(`${Number(at) - t0} [renderer] ${rest.join(' ')}`)
    }
  })
  await page.waitForFunction(() => Boolean(window.__store), null, { timeout: 60_000 })
  return { app, page, t0, log }
}

/** Types a marker into the first mounted pane until its output appears; stamps each phase. */
async function installProbe(page: Page, marker: string): Promise<void> {
  await page.evaluate(
    ({ marker, envId, autoSelect, project }) => {
      type Probe = Record<string, number | null | string>
      const d: Probe = {
        tPane: null,
        tPty: null,
        tFirstSend: null,
        tUsable: null,
        tEnvReady: null,
        tSession: null,
        sends: 0,
        pty: null,
        tAutoSelect: null,
        active: ''
      }
      ;(window as unknown as { __d3: Probe }).__d3 = d
      let lastSend = 0
      const iv = setInterval(() => {
        const store = window.__store
        const st = store?.getState() as unknown as Record<string, unknown> | undefined
        if (!st) {
          return
        }
        if (d.tSession === null && st.workspaceSessionReady === true) {
          d.tSession = Date.now()
        }
        const envs = (st.runtimeEnvironments ?? []) as { id: string }[]
        const wslStatus = (st.wslHostStatuses ?? {}) as Record<string, { state?: string }>
        if (d.tEnvReady === null && envs.some((e) => e.id === envId) && wslStatus[envId]?.state === 'ready') {
          d.tEnvReady = Date.now()
        }
        const active = String(st.activeWorktreeId ?? 'null')
        if (!String(d.active).endsWith(`=${active}`)) {
          d.active = `${d.active};${Date.now()}=${active}`
        }
        if (autoSelect && st.activeWorktreeId == null) {
          const state = store!.getState()
          const worktree = state.allWorktrees().find((entry) => entry.path.endsWith(project))
          if (worktree) {
            state.setActiveWorktree(worktree.id)
            d.tAutoSelect = Date.now()
            d.clicks = Number(d.clicks ?? 0) + 1
          }
        }
        const ptys = (st.ptyIdsByTabId ?? {}) as Record<string, string[]>
        for (const [tabId, manager] of window.__paneManagers ?? new Map()) {
          for (const pane of manager.getPanes?.() ?? []) {
            d.tPane ??= Date.now()
            const pty = ptys[tabId]?.[0]
            if (!pty) {
              continue
            }
            d.tPty ??= Date.now()
            d.pty = pty
            const buf = pane.terminal.buffer.active
            for (let i = Math.max(0, buf.length - 300); i < buf.length; i++) {
              if (buf.getLine(i)?.translateToString(true).includes(`${marker}_ok`)) {
                d.tUsable = Date.now()
                clearInterval(iv)
                return
              }
            }
            const now = Date.now()
            if (now - lastSend >= 150) {
              pane.terminal.input(`printf '%s_%s\\n' ${marker} ok\r`, true)
              lastSend = now
              d.sends = Number(d.sends) + 1
              d.tFirstSend ??= now
            }
            return
          }
        }
      }, 10)
    },
    { marker, envId: ENV_ID, autoSelect: process.env.D3_AUTOSELECT === '1', project: `/${PROJECT}` }
  )
}

async function measure(run: number, kind: string): Promise<void> {
  if (kind === 'cold') {
    await cleanupE2EDaemons(PROFILE)
    await wsl(['--terminate', DISTRO])
    for (let i = 0; i < 50 && (await distroRunning()); i++) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  const distroWasRunning = await distroRunning()
  const marker = `D3${Date.now().toString(36)}`
  const { app, page, t0, log } = await launch()
  try {
    const tWindow = Date.now()
    await installProbe(page, marker)
    await page
      .waitForFunction(
        () => Boolean((window as unknown as { __d3: { tUsable: number | null } }).__d3.tUsable),
        null,
        { timeout: Number(process.env.D3_TIMEOUT_MS ?? 120_000), polling: 100 }
      )
      .catch(async (error: unknown) => {
        const dump = await page.evaluate(() => {
          const st = window.__store!.getState()
          const panes: string[] = []
          for (const [tabId, manager] of window.__paneManagers ?? new Map()) {
            for (const pane of manager.getPanes?.() ?? []) {
              const buf = pane.terminal.buffer.active
              const lines: string[] = []
              for (let i = Math.max(0, buf.length - 25); i < buf.length; i++) {
                lines.push(buf.getLine(i)?.translateToString(true) ?? '')
              }
              panes.push(`${tabId}: ${lines.join('\n')}`)
            }
          }
          return JSON.stringify({
            d3: (window as unknown as { __d3: unknown }).__d3,
            active: st.activeWorktreeId,
            tabs: st.tabsByWorktree,
            ptys: st.ptyIdsByTabId,
            wsl: (st as unknown as { wslHostStatuses: unknown }).wslHostStatuses,
            panes
          })
        })
        console.log(`[d3] FAIL dump ${dump}`)
        console.log(log.join('\n'))
        throw error
      })
    const probe = await page.evaluate(
      () => (window as unknown as { __d3: Record<string, unknown> }).__d3
    )
    const processStart = await app.evaluate(() => Date.now() - performance.now())
    const rel = (value: unknown): number | null =>
      typeof value === 'number' ? value - t0 : null
    const row = {
      at: new Date().toISOString(),
      mode: MODE,
      step: kind,
      run,
      distro: DISTRO,
      distroWasRunning,
      launchToUsableMs: rel(probe.tUsable),
      launchToPtyMs: rel(probe.tPty),
      launchToPaneMs: rel(probe.tPane),
      launchToFirstSendMs: rel(probe.tFirstSend),
      launchToSessionReadyMs: rel(probe.tSession),
      launchToEnvReadyMs: rel(probe.tEnvReady),
      launchToAutoSelectMs: rel(probe.tAutoSelect),
      active: probe.active,
      launchToWindowMs: tWindow - t0,
      processStartOffsetMs: Math.round(processStart - t0),
      sends: probe.sends,
      pty: probe.pty,
      log
    }
    appendFileSync(OUT, `${JSON.stringify(row)}\n`)
    console.log(
      `[d3] ${MODE} ${kind} #${run} usable=${row.launchToUsableMs} pty=${row.launchToPtyMs} pane=${row.launchToPaneMs} session=${row.launchToSessionReadyMs} env=${row.launchToEnvReadyMs} auto=${row.launchToAutoSelectMs} clicks=${probe.clicks ?? 0} sends=${row.sends} active=${row.active}`
    )
  } finally {
    await closeElectronAppForE2E(app)
  }
}

async function setup(): Promise<void> {
  await wsl(
    buildWslExecArgs(DISTRO, [
      'sh',
      '-c',
      `mkdir -p ${GUEST_PROJECT} && cd ${GUEST_PROJECT} && (test -d .git || (git init -q -b main && echo d3 > README.md && git add . && git -c user.name=d3 -c user.email=d3@example.com commit -qm init))`
    ])
  )
  const { app, page, t0 } = await launch()
  try {
    await waitForSessionReady(page, 120_000)
    if (MODE === 'bridge') {
      const unc = `\\\\wsl.localhost\\${DISTRO}${GUEST_PROJECT.replace(/\//g, '\\')}`
      await page.evaluate(async (repoPath) => {
        const result = await window.api.repos.add({ path: repoPath })
        if ('error' in result) {
          throw new Error(result.error)
        }
      }, unc)
    } else {
      await page.evaluate(async () => {
        const settings = await window.api.settings.set({ experimentalWslHosts: true })
        window.__store?.setState({ settings })
      })
      const tAdd = Date.now()
      const added = await page.evaluate(
        (distro) =>
          window.api.runtimeEnvironments.wslHosts!.add({ distro, startIfStopped: true }),
        DISTRO
      )
      console.log(`[d3] host add ${Date.now() - tAdd}ms`, JSON.stringify(added).slice(0, 400))
      await page.evaluate(
        async ({ projectPath, envId }) => {
          const store = window.__store!
          await store.getState().addRepoPath(projectPath, 'git', { runtimeEnvironmentId: envId })
        },
        { projectPath: GUEST_PROJECT, envId: ENV_ID }
      )
    }
    await page.waitForFunction(
      (name) => {
        const state = window.__store!.getState()
        const repo = state.repos.find((entry) => entry.path.replace(/\\/g, '/').endsWith(name))
        const worktree = repo
          ? state.allWorktrees().find((entry) => entry.repoId === repo.id)
          : undefined
        if (!worktree) {
          return false
        }
        if (state.activeWorktreeId !== worktree.id) {
          state.setActiveWorktree(worktree.id)
        }
        return true
      },
      `/${PROJECT}`,
      { timeout: 120_000, polling: 500 }
    )
    await ensureTerminalVisible(page, 60_000)
    await installProbe(page, `D3setup${Date.now().toString(36)}`)
    await page.waitForFunction(
      () => Boolean((window as unknown as { __d3: { tUsable: number | null } }).__d3.tUsable),
      null,
      { timeout: 180_000, polling: 200 }
    )
    console.log(`[d3] setup ${MODE} first usable after ${Date.now() - t0}ms from launch`)
    // Let the session persist.
    await new Promise((resolve) => setTimeout(resolve, 3000))
  } finally {
    await closeElectronAppForE2E(app)
  }
}

test('d3 wsl startup bench', async () => {
  test.setTimeout(60 * 60_000)
  if (!PROFILE) {
    throw new Error('D3_PROFILE is required')
  }
  if (STEP === 'setup') {
    await setup()
    return
  }
  for (let run = 1; run <= RUNS; run++) {
    await measure(run, STEP)
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
})
