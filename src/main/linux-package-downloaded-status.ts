import type { UpdateStatus } from '../shared/update-status-types'
import {
  captureLinuxPackageArtifact,
  clearTrackedLinuxPackageArtifact
} from './linux-package-update-recovery'
import {
  getLinuxPackageType,
  LINUX_PACKAGE_MARKER_UNUSABLE_MESSAGE
} from './linux-update-package-type'

const PACKAGE_METADATA_UNUSABLE_MESSAGE =
  'The downloaded package metadata could not be verified. Quit Orca before downloading and installing the update from the official release page.'

export function resolveLinuxPackageDownloadedStatus(info: {
  version: string
}): UpdateStatus | null {
  const packageType = getLinuxPackageType()
  if (packageType === 'non-root') {
    return null
  }
  if (packageType === 'unusable') {
    clearTrackedLinuxPackageArtifact()
    return {
      state: 'error',
      message: LINUX_PACKAGE_MARKER_UNUSABLE_MESSAGE,
      version: info.version,
      retryable: false
    }
  }
  const artifact = captureLinuxPackageArtifact(info)
  if (!artifact) {
    return {
      state: 'error',
      message: PACKAGE_METADATA_UNUSABLE_MESSAGE,
      version: info.version,
      retryable: false
    }
  }
  return {
    state: 'error',
    message: 'Quit Orca before running the system package install command.',
    recovery: {
      kind: 'linux-package-install',
      packageType: artifact.packageType,
      reason: 'manual-install-required',
      version: artifact.version
    }
  }
}
