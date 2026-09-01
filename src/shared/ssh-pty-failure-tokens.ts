/** The execution host proved the session is gone. Callers may respawn. */
export const SSH_SESSION_EXPIRED_ERROR = 'SSH_SESSION_EXPIRED'

/** The relay found the PTY, but its recorded pane identity differs. */
export const SSH_PTY_IDENTITY_MISMATCH_ERROR = 'SSH_PTY_IDENTITY_MISMATCH'

/** The shell is live; only its output source needs a new delivery. */
export const SSH_SOURCE_RESTORE_REQUIRED_ERROR = 'SSH_SOURCE_RESTORE_REQUIRED'

export function isSshPtyIdentityMismatchMessage(message: string): boolean {
  return message.includes(SSH_PTY_IDENTITY_MISMATCH_ERROR) || /identity mismatch/i.test(message)
}
