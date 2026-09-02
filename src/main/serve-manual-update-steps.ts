import os from 'node:os'
import path from 'node:path'
import type { ServeManualUpdateMethod } from '../shared/remote-server-update'
import {
  buildLinuxPackageInstallCommand,
  quoteForPosixShell,
  resolveTrustedExecutable
} from './linux-package-install-command'

export const SERVE_UPGRADE_DOC_URL =
  'https://github.com/stablyai/orca/blob/main/docs/reference/headless-linux-server.md#upgrade'

// Why: no service unit name is knowable from inside the runtime, and #14068 forbids guessing one.
const RESTART_STEP =
  'Restart the service unit that runs `orca serve`. Orca does not restart itself: nothing here can prove exactly one replacement would start.'

function documentedProcedureStep(documentationUrl: string): string {
  return `Follow the documented upgrade procedure for this install: ${documentationUrl}`
}

/** Rejects anything a release tag should never contain before it reaches a shell-quoted path. */
function sanitizeVersionForFileName(version: string): string | null {
  return /^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version) ? version : null
}

function buildPackageSteps(
  method: 'deb' | 'rpm',
  latestVersion: string,
  releaseUrl: string,
  documentationUrl: string
): string[] {
  const safeVersion = sanitizeVersionForFileName(latestVersion)
  if (!safeVersion) {
    return [documentedProcedureStep(documentationUrl), RESTART_STEP]
  }
  // posix.join: this advice only ever describes a Linux host.
  const stagedPath = path.posix.join(os.tmpdir(), `orca-${safeVersion}.${method}`)
  const install = buildLinuxPackageInstallCommand(method, stagedPath)
  if (!install.ok) {
    return [documentedProcedureStep(documentationUrl), RESTART_STEP]
  }
  return [
    `Download the .${method} for this machine's architecture from ${releaseUrl} to ${stagedPath}`,
    install.command,
    RESTART_STEP
  ]
}

function buildAppImageSteps(
  appImagePath: string,
  releaseUrl: string,
  documentationUrl: string
): string[] {
  const sudoPath = resolveTrustedExecutable('sudo')
  const movePath = resolveTrustedExecutable('mv')
  if (!sudoPath || !movePath) {
    return [documentedProcedureStep(documentationUrl), RESTART_STEP]
  }
  const stagedPath = `${appImagePath}.new`
  return [
    // Why: the running AppImage is FUSE-mounted, so it must never be written in place.
    `Download the Linux AppImage for this machine's architecture from ${releaseUrl} to ${stagedPath}`,
    `${sudoPath} ${movePath} -- ${quoteForPosixShell(stagedPath)} ${quoteForPosixShell(appImagePath)}`,
    RESTART_STEP
  ]
}

/**
 * The exact operator steps for a host Orca refuses to update itself. Every command is a fixed
 * literal plus POSIX-single-quoted paths, and none of them is ever executed — the serve process
 * runs unprivileged with no authentication agent, so the privileged install stays the operator's
 * action by design.
 */
export function buildServeManualUpdateSteps(input: {
  method: ServeManualUpdateMethod
  latestVersion: string
  releaseUrl: string
  /** Absolute path of the running AppImage, when the method is `appimage`. */
  appImagePath: string | null
  documentationUrl?: string
}): string[] {
  const documentationUrl = input.documentationUrl ?? SERVE_UPGRADE_DOC_URL
  if (input.method === 'deb' || input.method === 'rpm') {
    return buildPackageSteps(input.method, input.latestVersion, input.releaseUrl, documentationUrl)
  }
  if (input.method === 'appimage' && input.appImagePath && path.isAbsolute(input.appImagePath)) {
    return buildAppImageSteps(input.appImagePath, input.releaseUrl, documentationUrl)
  }
  return [
    `Download the release for this machine's architecture from ${input.releaseUrl}`,
    documentedProcedureStep(documentationUrl),
    RESTART_STEP
  ]
}
