import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { reasonixCommittedBatches } from './session-scanner-reasonix-batches'
import { reasonixFrameRecords } from './session-scanner-reasonix-frames'

const kinds = new Set([
  'message/complete',
  'session/config',
  'turn/start',
  'turn/end',
  'assistant/attempt'
])
const real = readFileSync(join(__dirname, '__fixtures__', 'reasonix-1-39-7-loopback.frames'))
async function* chunks(content: Buffer) {
  for (let at = 0; at < content.length; at += 17) {
    yield content.subarray(at, at + 17)
  }
}
async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const item of source) {
    result.push(item)
  }
  return result
}
function frame(raw: Buffer): Buffer {
  const compressed = zstdCompressSync(raw, { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
  const header = Buffer.alloc(12)
  header.write('RX4F')
  header.writeUInt32BE(compressed.length, 4)
  header.writeUInt32BE(raw.length, 8)
  return Buffer.concat([header, compressed])
}
function batch(kind = 'message/complete', optional = false): Buffer[] {
  const records = [
    {
      schemaVersion: 4,
      codec: 'reasonix.session.linear/v4',
      recordType: 'batch/begin',
      commitId: 'commit',
      operationId: 'op',
      operationHash: 'hash',
      firstSeq: 1,
      eventCount: 1,
      writerGeneration: 1
    },
    {
      schemaVersion: 4,
      codec: 'reasonix.session.linear/v4',
      recordType: 'batch/event',
      event: {
        id: 'event',
        seq: 1,
        kind,
        optional,
        payload: Buffer.from('{"message":{"id":"m","role":"user","content":"test"}}').toString(
          'base64'
        )
      }
    }
  ].map((record) => Buffer.from(JSON.stringify(record)))
  const digest = createHash('sha256')
  for (const raw of records) {
    digest.update(raw).update('\0')
  }
  const end = Buffer.from(
    JSON.stringify({
      schemaVersion: 4,
      codec: 'reasonix.session.linear/v4',
      recordType: 'batch/end',
      commitId: 'commit',
      firstSeq: 1,
      eventCount: 1,
      sha256: digest.digest('hex')
    })
  )
  return [...records, end]
}

it('validates the actual released binary history across split frame headers', async () => {
  const batches = await collect(reasonixCommittedBatches(chunks(real), kinds))
  const payloads = batches
    .flatMap((batch) => batch.events)
    .flatMap((event) =>
      event.payload ? [Buffer.from(event.payload, 'base64').toString('utf8')] : []
    )
  expect(payloads.some((payload) => payload.includes('Orca loopback transport probe'))).toBe(true)
  expect(payloads.some((payload) => payload.includes('Loopback transport proof only.'))).toBe(true)
})

it('does not publish an uncommitted tail, including an unknown pending event', async () => {
  const raw = batch('future-required')
  expect(
    await collect(
      reasonixCommittedBatches(chunks(Buffer.concat(raw.slice(0, 2).map(frame))), kinds)
    )
  ).toEqual([])
  const frames = raw.map(frame)
  expect(
    await collect(
      reasonixCommittedBatches(
        chunks(Buffer.concat([frames[0], frames[1], frames[2].subarray(0, 15)])),
        kinds
      )
    )
  ).toEqual([])
})

it('rejects a damaged transaction digest even when frame checksums are valid', async () => {
  const raw = batch()
  raw[2] = Buffer.from(raw[2].toString().replace('"sha256":"', '"sha256":"0'))
  await expect(
    collect(reasonixCommittedBatches(chunks(Buffer.concat(raw.map(frame))), kinds))
  ).rejects.toThrow('checksum')
})

it('rejects a corrupt native Zstandard checksum', async () => {
  const compressed = frame(batch()[0])
  compressed[compressed.length - 1] ^= 1
  await expect(collect(reasonixFrameRecords(chunks(compressed)))).rejects.toThrow()
})

it('rejects an event sequence gap before exposing any batch', async () => {
  const raw = batch()
  raw[1] = Buffer.from(raw[1].toString().replace('"seq":1', '"seq":2'))
  await expect(
    collect(reasonixCommittedBatches(chunks(Buffer.concat(raw.map(frame))), kinds))
  ).rejects.toThrow('batch event')
})

it('ignores a huge uncommitted event count without preallocating its events', async () => {
  const raw = batch()
  raw[0] = Buffer.from(raw[0].toString().replace('"eventCount":1', '"eventCount":2147483647'))
  expect(await collect(reasonixCommittedBatches(chunks(frame(raw[0])), kinds))).toEqual([])
})

it('fails closed on a committed unknown required event but permits optional evolution', async () => {
  await expect(
    collect(
      reasonixCommittedBatches(chunks(Buffer.concat(batch('future-required').map(frame))), kinds)
    )
  ).rejects.toThrow('required event')
  expect(
    await collect(
      reasonixCommittedBatches(
        chunks(Buffer.concat(batch('future-optional', true).map(frame))),
        kinds
      )
    )
  ).toHaveLength(1)
})

it('rejects declared frame sizes before allocating or reading their body', async () => {
  const header = Buffer.alloc(12)
  header.write('RX4F')
  header.writeUInt32BE(0xffffffff, 4)
  header.writeUInt32BE(1, 8)
  await expect(collect(reasonixFrameRecords(chunks(header)))).rejects.toThrow('sizes')
})

it('closes its source when the consumer stops early', async () => {
  let closed = false
  async function* source() {
    try {
      yield real
    } finally {
      closed = true
    }
  }
  for await (const _batch of reasonixCommittedBatches(source(), kinds)) {
    break
  }
  expect(closed).toBe(true)
})

it('cancels before requesting more source bytes', async () => {
  const controller = new AbortController()
  controller.abort()
  let read = false
  async function* source() {
    read = true
    yield real
  }
  await expect(collect(reasonixFrameRecords(source(), controller.signal))).rejects.toThrow()
  expect(read).toBe(false)
})
