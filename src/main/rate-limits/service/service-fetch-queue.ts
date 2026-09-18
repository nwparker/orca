import { RateLimitServiceProviderCycles } from './service-provider-cycles'

type FetchKind = 'all' | 'codex' | 'claude' | 'grok' | 'devin'

export abstract class RateLimitServiceFetchQueue extends RateLimitServiceProviderCycles {
  protected fetchAll(options?: { force?: boolean }): Promise<void> {
    return this.fetchProvider('all', options?.force ?? false)
  }

  protected fetchCodexOnly(options?: { force?: boolean }): Promise<void> {
    return this.fetchProvider('codex', options?.force ?? false)
  }

  protected fetchClaudeOnly(options?: { force?: boolean }): Promise<void> {
    return this.fetchProvider('claude', options?.force ?? false)
  }

  protected fetchGrokOnly(options?: { force?: boolean }): Promise<void> {
    return this.fetchProvider('grok', options?.force ?? false)
  }

  protected fetchDevinOnly(options?: { force?: boolean }): Promise<void> {
    return this.fetchProvider('devin', options?.force ?? false)
  }

  private async fetchProvider(kind: FetchKind, force: boolean): Promise<void> {
    if (this.isFetching) {
      if (force) {
        this.queueFetch(kind)
        return this.waitForFetchIdle()
      }
      return
    }
    this.isFetching = true
    try {
      let next: FetchKind | null = kind
      let cycleForce = force
      while (next !== null) {
        const current = next
        const signal = await this.runWithFetchAbortSignal((signal) =>
          this.runProviderCycle(current, signal, cycleForce)
        )
        if (signal.aborted) {
          break
        }
        // Read live flags after every await; requests can arrive during any provider's cycle.
        next = this.takeQueuedFetch()
        cycleForce = true
      }
    } finally {
      this.isFetching = false
      this.resolveFetchIdleWaiters()
    }
  }

  private runProviderCycle(kind: FetchKind, signal: AbortSignal, force: boolean): Promise<void> {
    switch (kind) {
      case 'all':
        return this.runFetchAllCycle(signal, { force })
      case 'codex':
        return this.runFetchCodexOnlyCycle(signal)
      case 'claude':
        return this.runFetchClaudeOnlyCycle(signal, { force })
      case 'grok':
        return this.runFetchGrokOnlyCycle(signal)
      case 'devin':
        return this.runFetchDevinOnlyCycle(signal)
    }
  }

  private queueFetch(kind: FetchKind): void {
    switch (kind) {
      case 'all':
        this.fullFetchQueued = true
        break
      case 'codex':
        this.codexOnlyFetchQueued = true
        break
      case 'claude':
        this.claudeOnlyFetchQueued = true
        break
      case 'grok':
        this.grokOnlyFetchQueued = true
        break
      case 'devin':
        this.devinOnlyFetchQueued = true
        break
    }
  }

  private takeQueuedFetch(): FetchKind | null {
    if (this.fullFetchQueued) {
      this.fullFetchQueued = false
      return 'all'
    }
    if (this.codexOnlyFetchQueued) {
      this.codexOnlyFetchQueued = false
      return 'codex'
    }
    if (this.claudeOnlyFetchQueued) {
      this.claudeOnlyFetchQueued = false
      return 'claude'
    }
    if (this.grokOnlyFetchQueued) {
      this.grokOnlyFetchQueued = false
      return 'grok'
    }
    if (this.devinOnlyFetchQueued) {
      this.devinOnlyFetchQueued = false
      return 'devin'
    }
    return null
  }
}
