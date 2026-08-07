/**
 * Endpoint handover smoke — guards the split-brain failure with real daemon processes.
 *
 * Two starting daemons race to replace one dead endpoint entry. The loser may exit after the
 * winner has published, but its close must not remove the winner's canonical socket. The survivor
 * must remain reachable through that path with its own token.
 *
 * Unix only: Windows named pipes are not directory entries, so the mechanism cannot occur.
 *
 * Usage: node config/scripts/daemon-endpoint-handover-smoke.mjs
 */
import { fork } from 'node:child_process'
import { connect } from 'node:net'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..', '..')
const entryPath = join(repoRoot, 'out', 'main', 'daemon-entry.js')
const READY_TIMEOUT_MS = 20_000
const EXIT_TIMEOUT_MS = 15_000
const REACHABILITY_TIMEOUT_MS = 2_000

const log = (msg) => console.log(`[endpoint-handover-smoke] ${msg}`)

function readProtocolVersion() {
  const source = readFileSync(join(repoRoot, 'src/main/daemon/daemon-protocol-version.ts'), 'utf8')
  const match = source.match(/PROTOCOL_VERSION\s*=\s*(\d+)/)
  if (!match) {
    throw new Error('could not read daemon protocol version')
  }
  return Number(match[1])
}

function bootDaemon(tag, dir, socketPath) {
  const tokenPath = join(dir, `${tag}.token`)
  const pidPath = join(dir, `${tag}.pid`)
  const child = fork(
    entryPath,
    [
      '--socket',
      socketPath,
      '--token',
      tokenPath,
      '--pid-record',
      pidPath,
      '--launch-nonce',
      randomUUID(),
      '--entry-path',
      entryPath,
      '--app-version',
      'endpoint-handover-smoke'
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env, ORCA_USER_DATA_PATH: dir }
    }
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })
  const ready = new Promise((resolveReady, rejectReady) => {
    const timer = setTimeout(
      () => rejectReady(new Error(`daemon ${tag} never signaled ready.\nstderr:\n${stderr}`)),
      READY_TIMEOUT_MS
    )
    child.on('message', (msg) => {
      if (msg && typeof msg === 'object' && msg.type === 'ready') {
        clearTimeout(timer)
        resolveReady()
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      rejectReady(new Error(`daemon ${tag} exited with ${code}.\nstderr:\n${stderr}`))
    })
  })
  return { child, tokenPath, pidPath, ready }
}

function isReachable(socketPath) {
  return new Promise((resolveReachable) => {
    const socket = connect({ path: socketPath })
    socket.once('connect', () => {
      socket.destroy()
      resolveReachable(true)
    })
    socket.once('error', () => {
      socket.destroy()
      resolveReachable(false)
    })
  })
}

function isDaemonReachable(socketPath, tokenPath, protocolVersion) {
  if (!existsSync(tokenPath)) {
    return Promise.resolve(false)
  }
  const token = readFileSync(tokenPath, 'utf8').trim()
  return new Promise((resolveReachable) => {
    let buffer = ''
    let settled = false
    const socket = connect({ path: socketPath })
    const finish = (reachable) => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolveReachable(reachable)
    }
    const timer = setTimeout(() => finish(false), REACHABILITY_TIMEOUT_MS)
    socket.once('error', () => finish(false))
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          type: 'hello',
          version: protocolVersion,
          token,
          clientId: randomUUID(),
          role: 'control'
        })}\n`
      )
    })
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newlineIndex = buffer.indexOf('\n')
      if (newlineIndex === -1) {
        return
      }
      try {
        const message = JSON.parse(buffer.slice(0, newlineIndex))
        finish(message.type === 'hello' && message.ok === true)
      } catch {
        finish(false)
      }
    })
  })
}

function killAndWait(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error('daemon did not exit')), EXIT_TIMEOUT_MS)
    child.on('exit', () => {
      clearTimeout(timer)
      resolveExit()
    })
    child.kill('SIGTERM')
  })
}

async function main() {
  if (process.platform === 'win32') {
    log('SKIP: named pipes are not filesystem entries, so endpoint handover cannot occur')
    return
  }
  if (!existsSync(entryPath)) {
    throw new Error(`missing ${entryPath} — run \`pnpm build\` first`)
  }

  const dir = mkdtempSync(join(tmpdir(), 'orca-endpoint-handover-'))
  const socketPath = join(dir, 'daemon.sock')
  const protocolVersion = readProtocolVersion()
  const daemons = []
  try {
    const departed = bootDaemon('departed', dir, socketPath)
    daemons.push(departed)
    await departed.ready
    const deadInode = statSync(socketPath).ino
    await killAndWait(departed.child)
    if (!existsSync(socketPath) || statSync(socketPath).ino !== deadInode) {
      throw new Error('departing daemon did not leave its dead endpoint entry in place')
    }
    if (await isReachable(socketPath)) {
      throw new Error('departed daemon remains reachable')
    }
    log('daemon A departed and left a dead endpoint entry')

    const racers = [bootDaemon('racer-b', dir, socketPath), bootDaemon('racer-c', dir, socketPath)]
    daemons.push(...racers)
    const readiness = await Promise.allSettled(racers.map((daemon) => daemon.ready))
    if (readiness.every((result) => result.status === 'rejected')) {
      throw new Error(
        `neither racing daemon published the endpoint:\n${readiness
          .map((result) => (result.status === 'rejected' ? result.reason.message : ''))
          .join('\n')}`
      )
    }

    const owners = []
    for (const daemon of racers) {
      if (await isDaemonReachable(socketPath, daemon.tokenPath, protocolVersion)) {
        owners.push(daemon)
      }
    }
    if (owners.length !== 1) {
      throw new Error(`expected one reachable racing daemon, found ${owners.length}`)
    }
    const survivor = owners[0]
    const loser = racers.find((daemon) => daemon !== survivor)
    const survivorInode = statSync(socketPath).ino
    if (survivorInode === deadInode) {
      throw new Error('survivor did not replace the dead endpoint entry')
    }
    log('racing daemon published over the dead entry and is reachable')

    await killAndWait(loser.child)
    if (!existsSync(socketPath) || statSync(socketPath).ino !== survivorInode) {
      throw new Error("losing racer's exit removed the survivor's endpoint")
    }
    if (!(await isDaemonReachable(socketPath, survivor.tokenPath, protocolVersion))) {
      throw new Error("survivor became unreachable after the losing racer's exit")
    }
    if (!existsSync(survivor.pidPath)) {
      throw new Error('survivor lost its ownership record')
    }
    if (existsSync(loser.pidPath)) {
      throw new Error('losing racer left its ownership record behind')
    }

    log('PASS: the racing survivor remains reachable through the canonical endpoint')
  } finally {
    for (const daemon of daemons) {
      if (daemon.child.exitCode === null && daemon.child.signalCode === null) {
        try {
          daemon.child.kill('SIGKILL')
        } catch {
          // already gone
        }
      }
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(`[endpoint-handover-smoke] FAIL: ${error.message}`)
  process.exit(1)
})
