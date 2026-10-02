import { openRegularFileReadHandle } from '../shared/regular-file-open'
import { throwIfAiVaultScanCancelled } from '../main/ai-vault/ai-vault-scan-cancellation'
import { BinarySessionTranscriptError } from '../main/ai-vault/remote-session-content-lines'
import { BINARY_PROBE_BYTES, isBinaryBuffer } from './fs-handler-utils'
import { reasonixSessionLayout } from '../shared/reasonix-session-paths'
import { dshHomeFromSessionPath } from '../shared/dsh-session-paths'

/** The same open handle supplies the probe and stream, including across renames. */
export async function* readRelayTranscriptBytes(
  path: string,
  signal?: AbortSignal,
  format?: 'dsh-zstd' | 'reasonix-v4'
): AsyncGenerator<Buffer> {
  throwIfAiVaultScanCancelled(signal)
  const handle = await openRegularFileReadHandle(path, 'Expected a regular session file', signal)
  try {
    const probe = Buffer.alloc(BINARY_PROBE_BYTES)
    const { bytesRead } = await handle.read(probe, 0, probe.length, 0)
    const compressedDsh =
      format === 'dsh-zstd' &&
      path.endsWith('.zstd') &&
      dshHomeFromSessionPath(path) !== null &&
      bytesRead >= 4 &&
      probe.readUInt32LE(0) === 0xfd2fb528
    if (format === 'dsh-zstd' && !compressedDsh) {
      throw new Error('Expected a canonical DSH Zstandard transcript')
    }
    const reasonix =
      format === 'reasonix-v4' &&
      reasonixSessionLayout(path) !== null &&
      bytesRead >= 4 &&
      probe.readUInt32BE(0) === 0x52583446
    if (format === 'reasonix-v4' && !reasonix) {
      throw new Error('Expected a canonical Reasonix RX4F transcript')
    }
    if (!compressedDsh && !reasonix && isBinaryBuffer(probe.subarray(0, bytesRead))) {
      throw new BinarySessionTranscriptError()
    }
    const input = handle.createReadStream({ start: 0, autoClose: false, signal })
    try {
      for await (const chunk of input) {
        throwIfAiVaultScanCancelled(signal)
        if (!Buffer.isBuffer(chunk)) {
          throw new TypeError('Expected transcript byte buffer')
        }
        yield chunk
      }
    } finally {
      input.destroy()
    }
  } finally {
    await handle.close()
  }
}
