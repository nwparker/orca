import { describe, expect, it } from 'vitest'
import { decodeGetUserStatusQuota } from './devin-user-status-wire'

describe('Devin protobuf admission', () => {
  it.each([
    { bytes: [0, 0] },
    { bytes: [10, 255, 255, 255, 255, 255, 255, 255, 255, 255, 2] },
    { bytes: [10, 2, 128, 128] },
    { bytes: [10, 127] },
    { bytes: Array.from({ length: 100_000 }, () => 128) }
  ])('rejects malformed or oversized varints without scanning the entire input', ({ bytes }) => {
    expect(decodeGetUserStatusQuota(Uint8Array.from(bytes))).toBeNull()
  })
})
