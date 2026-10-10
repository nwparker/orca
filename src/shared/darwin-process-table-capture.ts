import { nameDarwinTerminals } from './darwin-terminal-names'
import { errorMessage } from './error-message'
import { PS_ARGS } from './process-table-snapshot'

let deviceColumnUnsupported = false

export async function captureDarwinProcessTable(
  capture: (args: readonly string[]) => Promise<string>,
  validate: (stdout: string) => string
): Promise<string> {
  if (deviceColumnUnsupported) {
    return capture(PS_ARGS)
  }
  let captured: string
  try {
    captured = await capture(['-axo', PS_ARGS[1].replace('tty=', 'tdev=')])
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      (error.code !== 1 && error.code !== 2) ||
      ('killed' in error && error.killed === true) ||
      !/^(?:ps: tdev: keyword not found|error: unknown user-defined format specifier "tdev")$/m.test(
        errorMessage(error)
      )
    ) {
      throw error
    }
    deviceColumnUnsupported = true
    return capture(PS_ARGS)
  }
  try {
    return validate(await nameDarwinTerminals(captured))
  } catch {
    return capture(PS_ARGS)
  }
}

export function resetDarwinProcessTableCaptureForTests(): void {
  deviceColumnUnsupported = false
}
