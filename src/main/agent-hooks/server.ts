// Why: this module is the Orca-main-process adapter for the shared
// agent-hook listener pipeline (`src/shared/agent-hook-listener.ts`). The
// listener internals (request parsing, payload normalization, endpoint-file
// writing, validation) live in `shared/` so the relay can host the same
// pipeline on the remote without dragging Electron in. This file owns:
//   - the loopback HTTP socket + bearer-token auth
//   - the IPC fanout (setListener / lastStatusByPaneKey replay)
//   - the `ingestRemote` entry point that bypasses HTTP for relay-forwarded
//     events (see docs/design/agent-status-over-ssh.md §5)
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { randomUUID } from 'crypto'
import { join } from 'path'

import { ORCA_HOOK_PROTOCOL_VERSION } from '../../shared/agent-hook-types'
import {
  clearAllListenerCaches,
  clearPaneCacheState,
  createHookListenerState,
  getEndpointFileName,
  HOOK_REQUEST_SLOWLORIS_MS,
  normalizeHookPayload,
  parseFormEncodedBody,
  readRequestBody,
  resolveHookSource,
  warnOnHookEnvOrVersionMismatch,
  writeEndpointFile,
  type AgentHookEventPayload,
  type HookListenerState
} from '../../shared/agent-hook-listener'
import type { AgentHookSource } from '../../shared/agent-hook-relay'

export type { AgentHookSource }

export class AgentHookServer {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private token = ''
  // Why: identifies this Orca instance so hook scripts can stamp requests and
  // the server can detect dev vs. prod cross-talk. Set at start() from the
  // caller's knowledge of whether this is a packaged build.
  private env = 'production'
  private onAgentStatus: ((payload: AgentHookEventPayload) => void) | null = null
  // Why: directory that holds the on-disk endpoint file. Set via start()'s
  // `userDataPath` option so the class has no direct Electron dependency
  // (keeps it mockable in the vitest node environment).
  private endpointDir: string | null = null
  private endpointFilePathCache: string | null = null
  private endpointFileWritten = false
  // Why: per-instance caches (warn-once Sets, lastPrompt/lastTool/lastStatus
  // by paneKey). Held on the instance instead of as module-level Maps so
  // tests can spin up multiple servers without state cross-contamination.
  private state: HookListenerState = createHookListenerState()

  setListener(listener: ((payload: AgentHookEventPayload) => void) | null): void {
    this.onAgentStatus = listener
    if (!listener) {
      return
    }
    // Why: replay is best-effort per pane so one throwing listener call can't
    // starve subsequent panes from being replayed.
    for (const payload of this.state.lastStatusByPaneKey.values()) {
      try {
        listener(payload)
      } catch (err) {
        console.error('[agent-hooks] replay listener threw', err)
      }
    }
  }

  /** Ingest a payload that arrived over the relay JSON-RPC channel rather
   *  than the local HTTP server. `connectionId` is the SshChannelMultiplexer
   *  identity Orca holds (the wire envelope carries connectionId: null and
   *  Orca stamps the real value here). The relay has already normalized the
   *  payload via the shared listener module, so we skip re-normalization and
   *  feed the envelope into the same `onAgentStatus` fanout the HTTP path
   *  uses. The `env`/`version` fields are forwarded verbatim from the agent
   *  CLI's POST body on the remote and validated here so the warn-once
   *  cross-build / dev-vs-prod diagnostics fire identically to the local
   *  HTTP path. See docs/design/agent-status-over-ssh.md §3, §5. */
  ingestRemote(
    envelope: {
      paneKey: string
      tabId?: string
      worktreeId?: string
      env?: string
      version?: string
      payload: unknown
    },
    connectionId: string
  ): void {
    if (!envelope || typeof envelope.paneKey !== 'string' || envelope.paneKey.length === 0) {
      return
    }
    const payload = envelope.payload
    if (
      typeof payload !== 'object' ||
      payload === null ||
      typeof (payload as { state?: unknown }).state !== 'string'
    ) {
      return
    }
    // Why: run the same warn-once diagnostics the HTTP path runs (cross-build
    // version mismatch, dev-vs-prod env mismatch). Use `this.env` as the
    // expected env so the messages match what the local server produces.
    warnOnHookEnvOrVersionMismatch(this.state, {
      version: envelope.version,
      env: envelope.env,
      expectedEnv: this.env
    })
    const event: AgentHookEventPayload = {
      paneKey: envelope.paneKey,
      tabId: envelope.tabId,
      worktreeId: envelope.worktreeId,
      connectionId,
      // Why: trust the relay-side normalization. The shared listener module
      // already enforced the field-shape invariants on the remote.
      payload: payload as AgentHookEventPayload['payload']
    }
    this.state.lastStatusByPaneKey.set(event.paneKey, event)
    this.onAgentStatus?.(event)
  }

  async start(options?: { env?: string; userDataPath?: string }): Promise<void> {
    if (this.server) {
      return
    }

    if (options?.env) {
      this.env = options.env
    }
    if (options?.userDataPath) {
      this.endpointDir = join(options.userDataPath, 'agent-hooks')
      this.endpointFilePathCache = join(this.endpointDir, getEndpointFileName())
    }
    this.token = randomUUID()
    this.endpointFileWritten = false
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }

      if (req.headers['x-orca-agent-hook-token'] !== this.token) {
        res.writeHead(403)
        res.end()
        return
      }

      // Why: bound request time so a slow/stalled client cannot hold a socket
      // open indefinitely (slowloris-style). The hook endpoints are local and
      // should complete in well under a second.
      req.setTimeout(HOOK_REQUEST_SLOWLORIS_MS, () => {
        req.destroy()
      })

      try {
        const body = await readRequestBody(req)
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        const source = resolveHookSource(pathname)
        if (!source) {
          res.writeHead(404)
          res.end()
          return
        }

        const payload = normalizeHookPayload(this.state, source, body, this.env)
        if (payload) {
          this.state.lastStatusByPaneKey.set(payload.paneKey, payload)
          this.onAgentStatus?.(payload)
        }

        res.writeHead(204)
        res.end()
      } catch {
        // Why: agent hooks must fail open. The receiver returns success for
        // malformed payloads so a newer or broken hook never blocks the agent.
        res.writeHead(204)
        res.end()
      }
    })

    await new Promise<void>((resolve, reject) => {
      // Why: swap the startup error handler on success so a later runtime
      // error (e.g. EADDRINUSE during rebind, socket errors) doesn't reject
      // an already-settled promise or crash the main process as unhandled.
      const onStartupError = (err: Error): void => {
        this.server?.off('listening', onListening)
        reject(err)
      }
      const onListening = (): void => {
        this.server?.off('error', onStartupError)
        this.server?.on('error', (err) => {
          console.error('[agent-hooks] server error', err)
        })
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        this.maybeWriteEndpointFile()
        resolve()
      }
      this.server!.once('error', onStartupError)
      this.server!.listen(0, '127.0.0.1', onListening)
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.token = ''
    this.env = 'production'
    this.onAgentStatus = null
    // Why: intentionally do NOT delete the endpoint file on stop(). A stale
    // file points at a dead port, which matches the fail-open policy. Unlink
    // would introduce a TOCTOU race vs. a concurrent Orca instance.
    this.endpointDir = null
    this.endpointFilePathCache = null
    this.endpointFileWritten = false
    clearAllListenerCaches(this.state)
  }

  clearPaneState(paneKey: string): void {
    clearPaneCacheState(this.state, paneKey)
  }

  buildPtyEnv(): Record<string, string> {
    if (this.port <= 0 || !this.token) {
      return {}
    }

    const env: Record<string, string> = {
      ORCA_AGENT_HOOK_PORT: String(this.port),
      ORCA_AGENT_HOOK_TOKEN: this.token,
      ORCA_AGENT_HOOK_ENV: this.env,
      ORCA_AGENT_HOOK_VERSION: ORCA_HOOK_PROTOCOL_VERSION
    }
    if (this.endpointFileWritten && this.endpointFilePathCache) {
      env.ORCA_AGENT_HOOK_ENDPOINT = this.endpointFilePathCache
    }
    return env
  }

  get endpointFilePath(): string | null {
    return this.endpointFilePathCache
  }

  private maybeWriteEndpointFile(): void {
    if (!this.endpointDir || !this.endpointFilePathCache) {
      return
    }
    this.endpointFileWritten = false
    const ok = writeEndpointFile(this.endpointDir, this.endpointFilePathCache, {
      port: this.port,
      token: this.token,
      env: this.env,
      version: ORCA_HOOK_PROTOCOL_VERSION
    })
    this.endpointFileWritten = ok
  }
}

export const agentHookServer = new AgentHookServer()

// Why: exported for test coverage of the per-agent field extractors.
export const _internals = {
  // Why: bind the test-helper to the singleton's state so existing tests keep
  // exercising the same caches the live server uses.
  normalizeHookPayload: (
    source: AgentHookSource,
    body: unknown,
    expectedEnv: string
  ): AgentHookEventPayload | null =>
    normalizeHookPayload(_singletonState(), source, body, expectedEnv),
  parseFormEncodedBody,
  resetCachesForTests: (): void => {
    clearAllListenerCaches(_singletonState())
  }
}

// Why: ergonomic accessor so the `_internals` shim can reach the singleton's
// per-instance state without exposing `state` on the public class surface.
function _singletonState(): HookListenerState {
  // The runtime field is private, but tests access this module exclusively
  // through `_internals`, which only fires after the module-level
  // `agentHookServer` is constructed. The cast keeps the compile-time
  // private invariant intact.
  return (agentHookServer as unknown as { state: HookListenerState }).state
}
