import { describe, expect, it } from 'vitest'
import {
  describeReattachFailure,
  isProvenSshSessionGoneError
} from './reattach-failure-classification'

describe('SSH reattach failure classification', () => {
  it('does not authorize a fresh spawn for a live source restore', () => {
    const error = new Error('SSH_SOURCE_RESTORE_REQUIRED: ssh-1@@pty-1')

    expect(isProvenSshSessionGoneError(error)).toBe(false)
    expect(describeReattachFailure(error)).toMatch(/re-established/i)
  })

  it('keeps proven absence eligible for replacement', () => {
    expect(isProvenSshSessionGoneError(new Error('SSH_SESSION_EXPIRED: ssh-1@@pty-1'))).toBe(true)
    expect(isProvenSshSessionGoneError(new Error('PTY "pty-1" not found'))).toBe(true)
  })

  it.each([
    new Error('PTY "pty-1" not found (identity mismatch)'),
    new Error('SSH_PTY_IDENTITY_MISMATCH: pty-1'),
    new Error('SSH_SESSION_EXPIRED: pty-1 SSH_PTY_IDENTITY_MISMATCH'),
    new Error('read ECONNRESET'),
    new Error('relay request timed out'),
    'unknown failure'
  ])('does not infer death from %s', (error) => {
    expect(isProvenSshSessionGoneError(error)).toBe(false)
  })
})
