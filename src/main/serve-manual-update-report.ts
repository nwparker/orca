import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import type {
  ServeManualUpdateCheckState,
  ServeManualUpdateMethod,
  ServeManualUpdateReport
} from '../shared/remote-server-update'
import { getLinuxRootPackageType } from './linux-update-package-type'
import {
  fetchNewerReleaseTagsWithReadiness,
  getReleaseTagUrl,
  normalizeTagToVersion
} from './updater-prerelease-feed'
import { isPrereleaseVersion } from './updater-fallback'
import { recordUpdaterLifecycle } from './updater-lifecycle-diagnostics'
import { AUTO_UPDATE_CHECK_INTERVAL_MS } from './updater/updater-state'
import { SERVE_UPGRADE_DOC_URL, buildServeManualUpdateSteps } from './serve-manual-update-steps'

type ReportState = {
  method: ServeManualUpdateMethod
  appImagePath: string | null
  check: ServeManualUpdateCheckState
  latestVersion: string | null
  latestTag: string | null
  lastAnnouncedVersion: string | null
}

let reportState: ReportState | null = null
let checkTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The active update method, read only from evidence the running install carries: the packaged
 * package-type marker `electron-updater` itself uses, and the AppImage runtime's own environment.
 * Nothing else is consulted, so an install that proves nothing reports `unknown`.
 */
export function detectServeUpdateMethod(): ServeManualUpdateMethod {
  const packageType = getLinuxRootPackageType()
  if (packageType) {
    return packageType
  }
  if (process.platform !== 'linux') {
    return 'unknown'
  }
  if (process.env.APPIMAGE) {
    return 'appimage'
  }
  // Why: AppRun exports APPDIR for an extracted tree, where no single binary swap applies.
  return process.env.APPDIR ? 'extracted-appimage' : 'unknown'
}

/**
 * The manual update contract for this host, or null when nothing started reporting one.
 *
 * Null is not "up to date" — it means this process never entered a mode that owns the contract,
 * so callers must keep treating an absent report as unknown.
 */
export function getServeManualUpdateReport(): ServeManualUpdateReport | null {
  if (!reportState) {
    return null
  }
  const releaseUrl = reportState.latestTag ? getReleaseTagUrl(reportState.latestTag) : null
  const steps =
    reportState.latestVersion && releaseUrl
      ? buildServeManualUpdateSteps({
          method: reportState.method,
          latestVersion: reportState.latestVersion,
          releaseUrl,
          appImagePath: reportState.appImagePath
        })
      : []
  return {
    method: reportState.method,
    check: reportState.check,
    currentVersion: app.getVersion(),
    latestVersion: reportState.latestVersion,
    releaseUrl,
    steps,
    documentationUrl: SERVE_UPGRADE_DOC_URL
  }
}

async function runServeUpdateCheck(): Promise<void> {
  const state = reportState
  if (!state) {
    return
  }
  const currentVersion = app.getVersion()
  const result = await fetchNewerReleaseTagsWithReadiness(currentVersion, 1, {
    includePrerelease: isPrereleaseVersion(currentVersion)
  })
  if (state !== reportState) {
    return
  }
  if (result.state === 'no-newer') {
    state.check = 'current'
    state.latestVersion = null
    state.latestTag = null
    return
  }
  const tag = result.state === 'ready' ? (result.tags[0] ?? null) : null
  if (!tag) {
    // Why: a feed failure and a mid-publish release both mean "not proven", so keep the last
    // known target rather than inventing a version the operator could not download yet.
    state.check = 'unavailable'
    return
  }
  state.check = 'update-available'
  state.latestTag = tag
  state.latestVersion = normalizeTagToVersion(tag)
  if (state.lastAnnouncedVersion === state.latestVersion) {
    return
  }
  // Bounded by construction: one record per newly observed version, not per check.
  state.lastAnnouncedVersion = state.latestVersion
  recordUpdaterLifecycle(
    'headless_serve_update_available',
    { method: state.method, currentVersion, latestVersion: state.latestVersion },
    {
      level: 'warn',
      message: `Orca ${state.latestVersion} is available; this install updates manually — run \`orca status\` for the exact commands`
    }
  )
}

function scheduleNextCheck(intervalMs: number): void {
  checkTimer = setTimeout(() => {
    void runCheckThenSchedule(intervalMs)
  }, intervalMs)
  checkTimer.unref?.()
}

async function runCheckThenSchedule(intervalMs: number): Promise<void> {
  await runServeUpdateCheck()
  if (reportState) {
    scheduleNextCheck(intervalMs)
  }
}

/**
 * Starts the status-only update contract for a headless serve host: detect the install method,
 * then poll the release feed on the same daily cadence the desktop updater uses. This never
 * downloads, installs, or restarts anything — it only makes the gap observable.
 */
export function startServeManualUpdateReporting(
  options: { intervalMs?: number } = {}
): Promise<void> {
  if (reportState) {
    return Promise.resolve()
  }
  reportState = {
    method: detectServeUpdateMethod(),
    appImagePath: process.env.APPIMAGE ?? null,
    check: 'pending',
    latestVersion: null,
    latestTag: null,
    lastAnnouncedVersion: null
  }
  if (!app.isPackaged || is.dev) {
    // Why: an unpackaged host has no release to compare against; report the method and stop.
    reportState.check = 'unavailable'
    return Promise.resolve()
  }
  return runCheckThenSchedule(options.intervalMs ?? AUTO_UPDATE_CHECK_INTERVAL_MS)
}

export function stopServeManualUpdateReporting(): void {
  if (checkTimer) {
    clearTimeout(checkTimer)
    checkTimer = null
  }
  reportState = null
}
