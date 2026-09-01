import {
  SSH_SESSION_EXPIRED_ERROR,
  SSH_SOURCE_RESTORE_REQUIRED_ERROR,
  isSshPtyIdentityMismatchMessage
} from '../../../../../shared/ssh-pty-failure-tokens'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Respawning requires host evidence that the old process no longer exists. */
export function isProvenSshSessionGoneError(error: unknown): boolean {
  const message = messageOf(error)
  if (
    message.includes(SSH_SOURCE_RESTORE_REQUIRED_ERROR) ||
    isSshPtyIdentityMismatchMessage(message)
  ) {
    return false
  }
  return message.includes(SSH_SESSION_EXPIRED_ERROR) || /PTY ".+" not found/i.test(message)
}

export function describeReattachFailure(error: unknown): string {
  const message = messageOf(error)
  return message.includes(SSH_SOURCE_RESTORE_REQUIRED_ERROR)
    ? 'Reconnecting this terminal — its output stream is being re-established.'
    : message
}
