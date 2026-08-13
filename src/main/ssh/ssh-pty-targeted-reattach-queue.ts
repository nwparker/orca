export const SSH_PTY_REATTACH_CANCELLED = Symbol('ssh-pty-reattach-cancelled')

export type SshPtyTargetedReattachResult = boolean | typeof SSH_PTY_REATTACH_CANCELLED

type TargetedReattach = Readonly<{ start: () => void; cancel: () => void }>

// Why bounded: every rejected frame asks for its own attach round trip, so a relay that starts
// rejecting across many PTYs at once fans out one concurrent reattach per PTY. The bulk reconnect
// path caps the identical work, and each attach also costs a lease read and a lease write.
export class SshPtyTargetedReattachQueue {
  private readonly running = new Map<string, TargetedReattach>()
  private readonly waiting: TargetedReattach[] = []
  private active = 0

  constructor(private readonly maxConcurrency: number) {}

  has(key: string): boolean {
    return this.running.has(key)
  }

  run(key: string, task: () => Promise<boolean>): Promise<SshPtyTargetedReattachResult> {
    return new Promise<SshPtyTargetedReattachResult>((resolve, reject) => {
      const entry: TargetedReattach = {
        start: () => {
          this.active++
          task().then(
            (recovered) => {
              this.settle(key, entry)
              resolve(recovered)
            },
            (error: unknown) => {
              this.settle(key, entry)
              reject(error instanceof Error ? error : new Error(String(error)))
            }
          )
        },
        cancel: () => resolve(SSH_PTY_REATTACH_CANCELLED)
      }
      this.running.set(key, entry)
      if (this.active < this.maxConcurrency) {
        entry.start()
        return
      }
      this.waiting.push(entry)
    })
  }

  // Why queued entries are dropped rather than started: each one is keyed to the provider generation
  // the teardown just ended, so running it would attach onto a mux that is already gone.
  clear(): void {
    for (const entry of this.waiting.splice(0)) {
      entry.cancel()
    }
    this.running.clear()
  }

  private settle(key: string, entry: TargetedReattach): void {
    if (this.running.get(key) === entry) {
      this.running.delete(key)
    }
    this.active--
    this.waiting.shift()?.start()
  }
}
