import { lstat, opendir } from 'node:fs/promises'
import { join } from 'node:path'
import { mapWithConcurrency } from './map-with-concurrency'
import { ProcessTableCaptureError } from './process-table-snapshot'

type DarwinTerminalNameDeps = {
  openDirectory: (path: string) => Promise<AsyncIterable<{ name: string }>>
  readDevice: (path: string) => Promise<{ rdev: bigint; isCharacterDevice: () => boolean }>
}

const deviceFilesystem: DarwinTerminalNameDeps = {
  openDirectory: opendir,
  readDevice: (path) => lstat(path, { bigint: true })
}

// The full capture's first six columns are fixed; localized dates and argv stay opaque.
const TDEV_COLUMN =
  /^([^\S\r\n]*\d+[^\S\r\n]+\d+[^\S\r\n]+-?\d+[^\S\r\n]+-?\d+[^\S\r\n]+\S+[^\S\r\n]+)(\S+)(?=[^\S\r\n]+\S)/
const TDEV_COLUMNS = new RegExp(TDEV_COLUMN.source, 'gm')

function isDeviceNumber(value: string): boolean {
  const match = value.match(/^(\d+)\/(\d+)$/)
  return match !== null && Number(match[1]) <= 255 && Number(match[2]) <= 0xffffff
}

async function readTerminalNames(
  deps: DarwinTerminalNameDeps
): Promise<ReadonlyMap<string, string>> {
  const entries: string[] = []
  for await (const entry of await deps.openDirectory('/dev')) {
    if (entry.name.includes('\uFFFD')) {
      throw new ProcessTableCaptureError('undecodable_device_name')
    }
    entries.push(entry.name)
  }
  const stats = await mapWithConcurrency(entries, 4, (name) =>
    deps.readDevice(join('/dev', name)).catch(() => null)
  )
  const names = new Map<string, string>()
  entries.forEach((name, index) => {
    const stat = stats[index]
    if (!stat?.isCharacterDevice()) {
      return
    }
    const device = BigInt.asUintN(32, stat.rdev)
    const signedDevice = BigInt.asIntN(32, stat.rdev)
    if (
      stat.rdev !== device &&
      stat.rdev !== signedDevice &&
      stat.rdev !== BigInt.asUintN(64, signedDevice)
    ) {
      return
    }
    const key = `${device >> 24n}/${device & 0xffffffn}`
    // Apple devname chooses the first direct character entry in native directory order.
    if (!names.has(key)) {
      names.set(key, Buffer.byteLength(name, 'utf8') < 255 ? name : '??')
    }
  })
  return names
}

/** Name terminals using this capture's /dev inventory, without retaining positive or misses. */
export async function nameDarwinTerminals(
  stdout: string,
  deps: DarwinTerminalNameDeps = deviceFilesystem
): Promise<string> {
  let hasDevices = false
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue
    }
    const match = line.match(TDEV_COLUMN)
    if (!match) {
      throw new ProcessTableCaptureError('malformed_darwin_device_row')
    }
    hasDevices ||= isDeviceNumber(match[2])
  }
  const names = hasDevices ? await readTerminalNames(deps) : new Map<string, string>()
  return stdout.replace(TDEV_COLUMNS, (_row, head: string, device: string) => {
    return head + (names.get(device) ?? '??')
  })
}
