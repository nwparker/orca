const NATIVE_PTY_ERROR_CODE_PATTERN = /\b(?:EIO|EPIPE|EBADF|ENXIO|EAGAIN)\b/
const NATIVE_PTY_MESSAGE_PATTERN =
  /^(?:Pty process exited|Invalid pty handle|Cannot resize a pty that has already exited|ioctl\(2\) failed(?:, (?:EBADF|EFAULT|EINVAL|ENOTTY))?)$/i
const NODE_PTY_STACK_PATTERN = /\bnode-pty[\\/]/i

function startsInNodePty(stack: string | undefined): boolean {
  const firstFrame = stack?.split('\n').find((line) => /^\s*at\b/.test(line))
  return firstFrame !== undefined && NODE_PTY_STACK_PATTERN.test(firstFrame)
}

export function isNativePtyException(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'Error') {
    return false
  }
  const code = 'code' in error && typeof error.code === 'string' ? error.code : null
  return (
    NATIVE_PTY_MESSAGE_PATTERN.test(error.message) ||
    (startsInNodePty(error.stack) && NATIVE_PTY_ERROR_CODE_PATTERN.test(code ?? error.message))
  )
}
