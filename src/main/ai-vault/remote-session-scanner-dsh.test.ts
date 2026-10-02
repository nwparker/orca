import { describe, expect, it } from 'vitest'
import { zstdCompressSync } from 'node:zlib'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import { scanRemoteAiVaultSessions } from './remote-session-scanner'
import { MemoryRemoteProvider } from './remote-session-scanner-test-fixtures'
import type { RemoteSessionFilesystemProvider } from './remote-session-scanner-types'

const data = Buffer.from(
  `${[
    {
      type: 'session',
      version: 4,
      id: 'remote-dsh',
      cwd: '/remote/plain-folder',
      createdAt: 1790920000000,
      isSeeded: false,
      delegationDepth: 0
    },
    {
      type: 'user/message',
      seq: 0,
      time: 1790920000100,
      data: {
        role: 'user',
        source: { kind: 'user' },
        content: [{ type: 'text', text: 'Remote DSH ask' }]
      }
    }
  ]
    .map((row) => JSON.stringify(row))
    .join('\n')}\n`
)
const directory = '/host/custom-dsh/sessions/project/remote-dsh'
const path = `${directory}/session.v4.jsonl.zstd`
const args = {
  executionHostId: 'ssh:proof-host' as const,
  remoteHome: '/remote/home',
  hostPlatform: getRemoteHostPlatform('linux-x64'),
  dshSessionsDir: '/host/custom-dsh/sessions'
}

describe('execution-host DSH history', () => {
  it('streams only latest generation from the provider and preserves host identity', async () => {
    const memory = new MemoryRemoteProvider()
    memory.addFile(path, 'binary placeholder', 5)
    memory.addFile(`${directory}/session.v3.jsonl.zstd`, 'must never read', 99)
    const reads: string[] = []
    const provider: RemoteSessionFilesystemProvider = {
      readDir: (path) => memory.readDir(path),
      stat: (path) => memory.stat(path),
      readFile: async () => {
        throw new Error('Never use text RPC or the client home')
      },
      readTranscriptBytes: async function* (path) {
        reads.push(path)
        yield zstdCompressSync(data)
      }
    }
    const result = await scanRemoteAiVaultSessions({ ...args, provider })
    expect(result.issues).toEqual([])
    expect(reads).toEqual([path])
    expect(result.sessions[0]).toMatchObject({
      agent: 'dsh',
      executionHostId: 'ssh:proof-host',
      executionHostPlatform: 'linux',
      cwd: '/remote/plain-folder',
      messageCount: 1
    })
    expect(result.sessions[0].resumeCommand).toContain("DSH_HOME='/host/custom-dsh'")
  })
  it('reports unavailable streaming on an older provider without reading bytes as text', async () => {
    const memory = new MemoryRemoteProvider()
    memory.addFile(path, 'binary placeholder', 5)
    const result = await scanRemoteAiVaultSessions({ ...args, provider: memory })
    expect(result.sessions).toEqual([])
    expect(result.issues).toEqual([
      expect.objectContaining({
        agent: 'dsh',
        message: expect.stringContaining('transcript-owning host')
      })
    ])
  })
})
