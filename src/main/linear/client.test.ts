import type * as OsModule from 'os'
import type * as ClientModule from './client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

type MockViewer = {
  displayName: string
  email?: string | null
  organization: Promise<{ id: string; name: string; urlKey?: string | null }>
}

type MockLinearClientInstance = {
  apiKey: string
  viewer: Promise<MockViewer>
}

const linearSdkMock = vi.hoisted(() => {
  class AuthenticationLinearError extends Error {}
  const state = {
    viewers: new Map<string, Promise<MockViewer> | MockViewer>()
  }
  const LinearClient = vi.fn(function (
    this: MockLinearClientInstance,
    options: { apiKey: string }
  ) {
    this.apiKey = options.apiKey
    this.viewer = Promise.resolve(
      state.viewers.get(options.apiKey) ?? {
        displayName: 'Ada',
        email: 'ada@example.com',
        organization: Promise.resolve({ id: 'org-orca', name: 'Orca', urlKey: 'orca' })
      }
    ).then((viewer) => viewer)
  })
  return { AuthenticationLinearError, LinearClient, state }
})

const safeStorageMock = vi.hoisted(() => ({
  encryptionAvailable: true,
  isEncryptionAvailable: vi.fn(() => safeStorageMock.encryptionAvailable),
  encryptString: vi.fn((text: string) => Buffer.from(`encrypted:${text}`)),
  decryptString: vi.fn((buffer: Buffer) => buffer.toString('utf-8').replace(/^encrypted:/, ''))
}))

const homeMock = vi.hoisted(() => ({
  home: '/tmp/orca-linear-client-home'
}))

vi.mock('@linear/sdk', () => ({
  LinearClient: linearSdkMock.LinearClient,
  AuthenticationLinearError: linearSdkMock.AuthenticationLinearError
}))

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: safeStorageMock.isEncryptionAvailable,
    encryptString: safeStorageMock.encryptString,
    decryptString: safeStorageMock.decryptString
  }
}))

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof OsModule>()
  return {
    ...actual,
    homedir: () => homeMock.home
  }
})

async function importClientModule(): Promise<typeof ClientModule> {
  return await import('./client')
}

function tokenPath(): string {
  return join(homeMock.home, '.orca', 'linear-token.enc')
}

function viewerPath(): string {
  return join(homeMock.home, '.orca', 'linear-viewer.json')
}

function workspaceFilePath(): string {
  return join(homeMock.home, '.orca', 'linear-workspaces.json')
}

function writeLegacyLinearFiles(token: string, viewer: Record<string, unknown>): void {
  const orcaDir = join(homeMock.home, '.orca')
  mkdirSync(orcaDir, { recursive: true })
  writeFileSync(tokenPath(), token, { encoding: 'utf-8' })
  writeFileSync(viewerPath(), JSON.stringify(viewer), { encoding: 'utf-8' })
}

function setViewer(
  apiKey: string,
  viewer: {
    displayName: string
    email?: string | null
    organizationId: string
    organizationName: string
    organizationUrlKey?: string | null
  }
): void {
  linearSdkMock.state.viewers.set(apiKey, {
    displayName: viewer.displayName,
    email: viewer.email,
    organization: Promise.resolve({
      id: viewer.organizationId,
      name: viewer.organizationName,
      urlKey: viewer.organizationUrlKey
    })
  })
}

describe('Linear client storage and connection', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    homeMock.home = mkdtempSync(join(tmpdir(), 'orca-linear-client-'))
    safeStorageMock.encryptionAvailable = true
    linearSdkMock.state.viewers = new Map()
    setViewer('token-alpha', {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationId: 'org-alpha',
      organizationName: 'Alpha',
      organizationUrlKey: 'alpha'
    })
    setViewer('token-beta', {
      displayName: 'Grace',
      email: 'grace@example.com',
      organizationId: 'org-beta',
      organizationName: 'Beta',
      organizationUrlKey: 'beta'
    })
  })

  afterEach(() => {
    rmSync(homeMock.home, { recursive: true, force: true })
  })

  it('encrypts, loads, and clears stored legacy tokens', async () => {
    const linearClient = await importClientModule()

    linearClient.saveToken('lin_api_key')

    expect(readFileSync(tokenPath()).toString('utf-8')).toBe('encrypted:lin_api_key')
    expect(linearClient.hasStoredToken('legacy')).toBe(true)
    expect(linearClient.hasStoredToken()).toBe(true)
    expect(linearClient.loadToken({ force: true, workspaceId: 'legacy' })).toBe('lin_api_key')
    expect(linearClient.loadToken({ force: true })).toBe('lin_api_key')

    linearClient.clearToken()

    expect(existsSync(tokenPath())).toBe(false)
    expect(linearClient.hasStoredToken()).toBe(false)
    expect(linearClient.loadToken({ force: true })).toBeNull()
  })

  it('falls back to plaintext token storage when OS encryption is unavailable', async () => {
    const linearClient = await importClientModule()
    safeStorageMock.encryptionAvailable = false
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    linearClient.saveToken('plain_key')

    expect(readFileSync(tokenPath(), 'utf-8')).toBe('plain_key')
    expect(safeStorageMock.encryptString).not.toHaveBeenCalled()
    expect(linearClient.loadToken({ force: true, workspaceId: 'legacy' })).toBe('plain_key')
  })

  it('reports status from plaintext viewer metadata without decrypting the token', async () => {
    writeLegacyLinearFiles('encrypted:stored_key', {
      displayName: 'Ada Lovelace',
      email: 'ada@example.com',
      organizationName: 'Orca'
    })
    const linearClient = await importClientModule()

    expect(linearClient.getStatus()).toMatchObject({
      connected: true,
      viewer: {
        id: 'legacy',
        displayName: 'Ada Lovelace',
        email: 'ada@example.com',
        organizationName: 'Orca',
        isLegacy: true
      },
      selectedWorkspaceId: 'legacy',
      workspaces: [{ id: 'legacy', organizationName: 'Orca', isLegacy: true }]
    })
    expect(safeStorageMock.decryptString).not.toHaveBeenCalled()

    linearClient.initLinearToken()
    expect(linearClient.getStatus().viewer?.displayName).toBe('Ada Lovelace')
  })

  it('stores multiple workspaces and remembers the selected workspace', async () => {
    const linearClient = await importClientModule()

    await expect(linearClient.connect('token-alpha')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-alpha', organizationName: 'Alpha' }
    })
    await expect(linearClient.connect('token-beta')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-beta', organizationName: 'Beta' }
    })

    expect(linearClient.getStatus()).toMatchObject({
      connected: true,
      selectedWorkspaceId: 'org-beta',
      workspaces: [
        { id: 'org-alpha', organizationName: 'Alpha' },
        { id: 'org-beta', organizationName: 'Beta' }
      ]
    })

    expect(linearClient.selectWorkspace('all')).toMatchObject({ selectedWorkspaceId: 'all' })

    linearClient.disconnect('org-alpha')
    expect(linearClient.getStatus()).toMatchObject({
      connected: true,
      workspaces: [{ id: 'org-beta', organizationName: 'Beta' }]
    })
  })

  it('migrates legacy token storage to a real workspace id when explicitly tested', async () => {
    writeLegacyLinearFiles('token-alpha', {
      displayName: 'Ada',
      email: 'ada@example.com',
      organizationName: 'Alpha'
    })
    const linearClient = await importClientModule()

    await expect(linearClient.testConnection('legacy')).resolves.toMatchObject({
      ok: true,
      workspace: { id: 'org-alpha', organizationName: 'Alpha' }
    })

    const status = linearClient.getStatus()
    expect(status).toMatchObject({
      connected: true,
      selectedWorkspaceId: 'org-alpha',
      workspaces: [{ id: 'org-alpha', organizationName: 'Alpha' }]
    })
    expect(status.workspaces?.some((workspace) => workspace.id === 'legacy')).toBe(false)
    expect(existsSync(tokenPath())).toBe(false)
    expect(readFileSync(workspaceFilePath(), 'utf-8')).toContain('org-alpha')
  })

  it('returns user-facing errors and clears auth failures during connection tests', async () => {
    const linearClient = await importClientModule()
    linearSdkMock.state.viewers.set('bad_key', Promise.reject(new Error('bad key')))

    await expect(linearClient.connect('bad_key')).resolves.toEqual({
      ok: false,
      error: 'bad key'
    })
    await expect(linearClient.testConnection()).resolves.toEqual({
      ok: false,
      error: 'No API key stored.'
    })

    linearClient.saveToken('stored_key')
    const authError = new linearSdkMock.AuthenticationLinearError('unauthorized')
    linearSdkMock.state.viewers.set('stored_key', Promise.reject(authError))

    await expect(linearClient.testConnection('legacy')).resolves.toEqual({
      ok: false,
      error: 'unauthorized'
    })
    expect(linearClient.isAuthError(authError)).toBe(true)
    expect(linearClient.hasStoredToken('legacy')).toBe(false)
  })

  it('limits concurrent API calls and releases queued callers', async () => {
    const linearClient = await importClientModule()

    await Promise.all([
      linearClient.acquire(),
      linearClient.acquire(),
      linearClient.acquire(),
      linearClient.acquire()
    ])

    let fifthResolved = false
    const fifthAcquire = linearClient.acquire().then(() => {
      fifthResolved = true
    })
    await Promise.resolve()
    expect(fifthResolved).toBe(false)

    linearClient.release()
    await fifthAcquire
    expect(fifthResolved).toBe(true)

    linearClient.release()
    linearClient.release()
    linearClient.release()
    linearClient.release()
  })
})
