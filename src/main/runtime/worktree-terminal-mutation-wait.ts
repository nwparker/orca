export async function waitForWorktreeTerminalMutation(
  previous: Promise<void>,
  deadline?: number
): Promise<void> {
  if (deadline === undefined) {
    await previous
    return
  }
  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) {
    throw new Error('terminal_worktree_sleep_timeout')
  }
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      previous,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('terminal_worktree_sleep_timeout')),
          remainingMs
        )
      })
    ])
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout)
    }
  }
}
