/* eslint-disable max-lines -- Why: browser-cookie import coverage needs shared
   filesystem/browser-profile fixtures across Chrome, Firefox, and Safari cases. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { appGetPathMock, sessionFromPartitionMock, dialogShowOpenDialogMock, execFileSyncMock } =
  vi.hoisted(() => ({
    appGetPathMock: vi.fn(),
    sessionFromPartitionMock: vi.fn(),
    dialogShowOpenDialogMock: vi.fn(),
    execFileSyncMock: vi.fn(() => 'mock-secret\n')
  }))

type CookieDetails = {
  domain?: string
  name?: string
  sameSite?: string
  secure?: boolean
  url?: string
}
type CookieSetMock = ReturnType<typeof vi.fn<(details: CookieDetails) => Promise<void>>>

vi.mock('electron', () => ({
  app: { getPath: appGetPathMock },
  BrowserWindow: { fromWebContents: vi.fn() },
  dialog: { showOpenDialog: dialogShowOpenDialogMock },
  session: { fromPartition: sessionFromPartitionMock }
}))

vi.mock('node:child_process', () => ({
  execFileSync: execFileSyncMock
}))

import {
  detectInstalledBrowsers,
  importCookiesFromBrowser,
  importCookiesFromFile,
  pickCookieFile,
  selectBrowserProfile
} from './browser-cookie-import'
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'

function restorePlatform(
  descriptor: PropertyDescriptor | undefined,
  originalPlatform: NodeJS.Platform
): void {
  if (descriptor) {
    Object.defineProperty(process, 'platform', descriptor)
    return
  }
  Object.defineProperty(process, 'platform', {
    value: originalPlatform
  })
}

function createElectronSessionMock(
  cookiesSetMock: CookieSetMock = vi.fn().mockResolvedValue(undefined)
) {
  return {
    cookies: {
      set: cookiesSetMock,
      remove: vi.fn().mockResolvedValue(undefined),
      flushStore: vi.fn().mockResolvedValue(undefined)
    },
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    setUserAgent: vi.fn()
  }
}

describe('importCookiesFromFile', () => {
  let tmpDir: string
  let cookiesSetMock: CookieSetMock

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-cookie-test-'))
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    appGetPathMock.mockReset()
    appGetPathMock.mockReturnValue(tmpDir)
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue(createElectronSessionMock(cookiesSetMock))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeCookieFile(cookies: unknown[]): string {
    const filePath = join(tmpDir, 'cookies.json')
    writeFileSync(filePath, JSON.stringify(cookies))
    return filePath
  }

  it('imports valid cookies', async () => {
    const filePath = writeCookieFile([
      {
        domain: '.github.com',
        name: '_gh_sess',
        value: 'abc123',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'lax',
        expirationDate: 1800000000
      },
      {
        domain: '.example.com',
        name: 'test',
        value: 'val',
        path: '/',
        secure: false,
        httpOnly: false
      }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.summary.totalCookies).toBe(2)
    expect(result.summary.importedCookies).toBe(2)
    expect(result.summary.skippedCookies).toBe(0)
    expect(result.summary.domains).toContain('github.com')
    expect(result.summary.domains).toContain('example.com')

    expect(cookiesSetMock).toHaveBeenCalledTimes(2)
    const firstCall = cookiesSetMock.mock.calls[0][0]
    expect(firstCall.name).toBe('_gh_sess')
    expect(firstCall.domain).toBe('.github.com')
    expect(firstCall.secure).toBe(true)
    expect(firstCall.sameSite).toBe('lax')
  })

  it('rejects non-JSON files', async () => {
    const filePath = join(tmpDir, 'bad.json')
    writeFileSync(filePath, 'not json at all')

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('not valid JSON')
  })

  it('rejects non-array JSON', async () => {
    const filePath = join(tmpDir, 'object.json')
    writeFileSync(filePath, '{"domain": "test.com"}')

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('JSON array')
  })

  it('rejects empty array', async () => {
    const filePath = writeCookieFile([])
    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('empty')
  })

  it('skips entries with missing required fields', async () => {
    const filePath = writeCookieFile([
      { domain: '.valid.com', name: 'ok', value: 'val' },
      { name: 'no-domain', value: 'val' },
      { domain: '.valid2.com', value: 'no-name' },
      { domain: '.valid3.com', name: 'no-value' },
      'not an object',
      42
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.summary.importedCookies).toBe(1)
    expect(result.summary.skippedCookies).toBe(5)
  })

  it('reports all skipped when no valid cookies', async () => {
    const filePath = writeCookieFile([
      { name: 'no-domain', value: 'val' },
      { domain: '', name: 'empty-domain', value: 'val' }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('No valid cookies')
    expect(result.reason).toContain('2 entries were skipped')
  })

  it('handles file read errors', async () => {
    const result = await importCookiesFromFile('/nonexistent/path.json', 'persist:test')
    expect(result.ok).toBe(false)
    if (result.ok) {
      return
    }
    expect(result.reason).toContain('Could not read')
  })

  it('normalizes sameSite values', async () => {
    const filePath = writeCookieFile([
      { domain: '.test.com', name: 'a', value: '1', sameSite: 'None' },
      { domain: '.test.com', name: 'b', value: '2', sameSite: 'Lax' },
      { domain: '.test.com', name: 'c', value: '3', sameSite: 'Strict' },
      { domain: '.test.com', name: 'd', value: '4', sameSite: 'unknown' },
      { domain: '.test.com', name: 'e', value: '5' }
    ])

    await importCookiesFromFile(filePath, 'persist:test')

    expect(cookiesSetMock.mock.calls[0][0].sameSite).toBe('no_restriction')
    expect(cookiesSetMock.mock.calls[1][0].sameSite).toBe('lax')
    expect(cookiesSetMock.mock.calls[2][0].sameSite).toBe('strict')
    expect(cookiesSetMock.mock.calls[3][0].sameSite).toBe('unspecified')
    expect(cookiesSetMock.mock.calls[4][0].sameSite).toBe('unspecified')
  })

  it('derives correct URL from domain and secure flag', async () => {
    const filePath = writeCookieFile([
      { domain: '.secure.com', name: 'a', value: '1', secure: true },
      { domain: '.insecure.com', name: 'b', value: '2', secure: false },
      { domain: 'nodot.com', name: 'c', value: '3' }
    ])

    await importCookiesFromFile(filePath, 'persist:test')

    expect(cookiesSetMock.mock.calls[0][0].url).toBe('https://secure.com/')
    expect(cookiesSetMock.mock.calls[1][0].url).toBe('http://insecure.com/')
    expect(cookiesSetMock.mock.calls[2][0].url).toBe('http://nodot.com/')
  })

  it('counts cookies that fail to set', async () => {
    cookiesSetMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('set failed'))

    const filePath = writeCookieFile([
      { domain: '.a.com', name: 'ok', value: '1' },
      { domain: '.b.com', name: 'fail', value: '2' }
    ])

    const result = await importCookiesFromFile(filePath, 'persist:test')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.summary.importedCookies).toBe(1)
    expect(result.summary.skippedCookies).toBe(1)
  })
})

describe('detectInstalledBrowsers', () => {
  it('returns an array of detected browsers', () => {
    const browsers = detectInstalledBrowsers()
    expect(Array.isArray(browsers)).toBe(true)
    for (const browser of browsers) {
      expect(browser).toHaveProperty('family')
      expect(browser).toHaveProperty('label')
      expect(browser).toHaveProperty('cookiesPath')
      // keychainService/keychainAccount are only present for Chromium-based browsers
      if (['chrome', 'edge', 'arc', 'chromium'].includes(browser.family)) {
        expect(browser).toHaveProperty('keychainService')
        expect(browser).toHaveProperty('keychainAccount')
      }
    }
  })

  it('each detected browser has a valid family', () => {
    const browsers = detectInstalledBrowsers()
    const validFamilies = ['chrome', 'edge', 'arc', 'chromium', 'firefox', 'safari', 'comet']
    for (const browser of browsers) {
      expect(validFamilies).toContain(browser.family)
    }
  })
})

describe('pickCookieFile', () => {
  beforeEach(() => {
    dialogShowOpenDialogMock.mockReset()
  })

  it('returns the selected path and handles cancellation', async () => {
    dialogShowOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ['/tmp/cookies.json']
    })
    await expect(pickCookieFile(null)).resolves.toBe('/tmp/cookies.json')

    dialogShowOpenDialogMock.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    await expect(pickCookieFile(null)).resolves.toBeNull()
  })
})

describe('importCookiesFromBrowser', () => {
  let tmpDir: string
  let cookiesSetMock: CookieSetMock

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-browser-cookie-test-'))
    cookiesSetMock = vi.fn().mockResolvedValue(undefined)
    appGetPathMock.mockReset()
    appGetPathMock.mockReturnValue(tmpDir)
    sessionFromPartitionMock.mockReset()
    sessionFromPartitionMock.mockReturnValue(createElectronSessionMock(cookiesSetMock))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function writeFirefoxCookies(rows: Record<string, string | number>[]): string {
    const dbPath = join(tmpDir, 'firefox-cookies.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE moz_cookies (
        name TEXT,
        value TEXT,
        host TEXT,
        path TEXT,
        expiry INTEGER,
        isSecure INTEGER,
        isHttpOnly INTEGER,
        sameSite INTEGER
      )
    `)
    const insert = db.prepare(
      'INSERT INTO moz_cookies (name, value, host, path, expiry, isSecure, isHttpOnly, sameSite) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    )
    for (const row of rows) {
      insert.run(
        row.name,
        row.value,
        row.host,
        row.path,
        row.expiry,
        row.isSecure,
        row.isHttpOnly,
        row.sameSite
      )
    }
    db.close()
    return dbPath
  }

  function createChromiumCookiesDb(dbPath: string): DatabaseSync {
    const db = new DatabaseSync(dbPath)
    db.exec(`
      CREATE TABLE cookies (
        creation_utc INTEGER,
        host_key TEXT,
        top_frame_site_key TEXT,
        name TEXT,
        value BLOB,
        encrypted_value BLOB,
        path TEXT,
        expires_utc INTEGER,
        is_secure INTEGER,
        is_httponly INTEGER,
        last_access_utc INTEGER,
        has_expires INTEGER,
        is_persistent INTEGER,
        priority INTEGER,
        samesite INTEGER,
        source_scheme INTEGER,
        source_port INTEGER,
        is_same_party INTEGER
      )
    `)
    return db
  }

  function insertChromiumCookie(
    db: DatabaseSync,
    row: {
      host: string
      name: string
      value: string
      path?: string
      secure?: number
      httpOnly?: number
      sameSite?: number
      expiresUnix?: number
    }
  ): void {
    const expiresUtc =
      row.expiresUnix && row.expiresUnix > 0
        ? (BigInt(row.expiresUnix) + 11644473600n) * 1000000n
        : 0n
    db.prepare(
      `INSERT INTO cookies (
        creation_utc,
        host_key,
        top_frame_site_key,
        name,
        value,
        encrypted_value,
        path,
        expires_utc,
        is_secure,
        is_httponly,
        last_access_utc,
        has_expires,
        is_persistent,
        priority,
        samesite,
        source_scheme,
        source_port,
        is_same_party
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1,
      row.host,
      '',
      row.name,
      Buffer.from(row.value, 'latin1'),
      Buffer.alloc(0),
      row.path ?? '/',
      expiresUtc,
      row.secure ?? 0,
      row.httpOnly ?? 0,
      1,
      row.expiresUnix ? 1 : 0,
      1,
      1,
      row.sameSite ?? 0,
      row.secure ? 2 : 1,
      row.secure ? 443 : 80,
      0
    )
  }

  function safariCookieFile(): string {
    const cookie = Buffer.alloc(128)
    const strings = [
      { key: 'url', value: '.apple.com' },
      { key: 'name', value: 'session' },
      { key: 'path', value: '/' },
      { key: 'value', value: 'abc123' }
    ] as const
    let cursor = 56
    const offsets = new Map<string, number>()
    for (const entry of strings) {
      offsets.set(entry.key, cursor)
      cursor += cookie.write(entry.value, cursor, 'utf8')
      cookie[cursor++] = 0
    }
    cookie.writeUInt32LE(cursor, 0)
    cookie.writeUInt32LE(1 | 4, 8)
    cookie.writeUInt32LE(offsets.get('url') ?? 0, 16)
    cookie.writeUInt32LE(offsets.get('name') ?? 0, 20)
    cookie.writeUInt32LE(offsets.get('path') ?? 0, 24)
    cookie.writeUInt32LE(offsets.get('value') ?? 0, 28)
    cookie.writeDoubleLE(0, 40)

    const page = Buffer.alloc(12 + cursor)
    page.writeUInt32BE(0x00000100, 0)
    page.writeUInt32LE(1, 4)
    page.writeUInt32LE(12, 8)
    cookie.subarray(0, cursor).copy(page, 12)

    const file = Buffer.alloc(12 + page.length)
    file.write('cook', 0, 'utf8')
    file.writeUInt32BE(1, 4)
    file.writeUInt32BE(page.length, 8)
    page.copy(file, 12)

    const filePath = join(tmpDir, 'Cookies.binarycookies')
    writeFileSync(filePath, file)
    return filePath
  }

  it('imports valid Firefox cookies and filters expired or malformed rows', async () => {
    const now = Math.floor(Date.now() / 1000)
    const cookiesPath = writeFirefoxCookies([
      {
        name: 'sid',
        value: 'abc',
        host: '.mozilla.org',
        path: '/',
        expiry: now + 3600,
        isSecure: 1,
        isHttpOnly: 1,
        sameSite: 1
      },
      {
        name: 'expired',
        value: 'old',
        host: '.mozilla.org',
        path: '/',
        expiry: now - 5,
        isSecure: 0,
        isHttpOnly: 0,
        sameSite: 0
      },
      {
        name: '',
        value: 'missing-name',
        host: '.mozilla.org',
        path: '/',
        expiry: now + 3600,
        isSecure: 0,
        isHttpOnly: 0,
        sameSite: 2
      }
    ])

    const result = await importCookiesFromBrowser(
      {
        family: 'firefox',
        label: 'Firefox',
        cookiesPath,
        profiles: [{ name: 'default', directory: 'default' }],
        selectedProfile: 'default'
      },
      'persist:test'
    )

    expect(result).toMatchObject({
      ok: true,
      summary: {
        totalCookies: 3,
        importedCookies: 1,
        skippedCookies: 2,
        domains: ['mozilla.org']
      }
    })
    expect(cookiesSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://mozilla.org/',
        name: 'sid',
        value: 'abc',
        sameSite: 'lax'
      })
    )
  })

  it('returns a Firefox-specific empty-source error', async () => {
    const cookiesPath = writeFirefoxCookies([])
    await expect(
      importCookiesFromBrowser(
        {
          family: 'firefox',
          label: 'Firefox',
          cookiesPath,
          profiles: [{ name: 'default', directory: 'default' }],
          selectedProfile: 'default'
        },
        'persist:test'
      )
    ).resolves.toEqual({ ok: false, reason: 'No cookies found in Firefox.' })
  })

  it('imports Safari binary cookies', async () => {
    const result = await importCookiesFromBrowser(
      {
        family: 'safari',
        label: 'Safari',
        cookiesPath: safariCookieFile(),
        profiles: [{ name: 'Default', directory: 'Default' }],
        selectedProfile: 'Default'
      },
      'persist:test'
    )

    expect(result).toMatchObject({
      ok: true,
      summary: {
        totalCookies: 1,
        importedCookies: 1,
        skippedCookies: 0,
        domains: ['apple.com']
      }
    })
    expect(cookiesSetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://apple.com/',
        name: 'session',
        value: 'abc123',
        secure: true,
        httpOnly: true
      })
    )
  })

  it('rejects missing source databases before dispatching', async () => {
    await expect(
      importCookiesFromBrowser(
        {
          family: 'firefox',
          label: 'Firefox',
          cookiesPath: join(tmpDir, 'missing.sqlite'),
          profiles: [{ name: 'default', directory: 'default' }],
          selectedProfile: 'default'
        },
        'persist:test'
      )
    ).resolves.toEqual({ ok: false, reason: 'Firefox cookies database not found.' })
  })

  it('imports Chromium cookies through the staging database and skips Google integrity cookies', async () => {
    const originalPlatform = process.platform
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: 'linux' })

    try {
      execFileSyncMock.mockReturnValue('keyring-secret\n')
      const sourcePath = join(tmpDir, 'Chromium-Cookies')
      const sourceDb = createChromiumCookiesDb(sourcePath)
      insertChromiumCookie(sourceDb, {
        host: '.example.com',
        name: 'sid',
        value: 'abc',
        secure: 1,
        httpOnly: 1,
        sameSite: 2,
        expiresUnix: Math.floor(Date.now() / 1000) + 3600
      })
      insertChromiumCookie(sourceDb, {
        host: '.host.test',
        name: '__Host-auth',
        value: 'host-value',
        path: '/wrong',
        secure: 1
      })
      insertChromiumCookie(sourceDb, {
        host: '.google.com',
        name: 'AEC',
        value: 'bound-to-source-browser',
        secure: 1
      })
      sourceDb.close()

      const liveCookieDir = join(tmpDir, 'Partitions', 'chromium-profile')
      mkdirSync(liveCookieDir, { recursive: true })
      createChromiumCookiesDb(join(liveCookieDir, 'Cookies')).close()

      const result = await importCookiesFromBrowser(
        {
          family: 'chrome',
          label: 'Google Chrome',
          cookiesPath: sourcePath,
          keychainService: 'Chrome Safe Storage',
          keychainAccount: 'Chrome',
          profiles: [{ name: 'Default', directory: 'Default' }],
          selectedProfile: 'Default'
        },
        'persist:chromium-profile'
      )

      expect(result).toMatchObject({
        ok: true,
        summary: {
          totalCookies: 3,
          importedCookies: 2,
          skippedCookies: 0,
          domains: ['example.com', 'host.test']
        }
      })
      expect(cookiesSetMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com/',
          name: 'sid',
          value: 'abc',
          domain: '.example.com',
          httpOnly: true,
          sameSite: 'lax'
        })
      )
      expect(cookiesSetMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://host.test/',
          name: '__Host-auth',
          path: '/'
        })
      )
      const hostCookieCall = cookiesSetMock.mock.calls.find(
        ([cookie]) => cookie.name === '__Host-auth'
      )?.[0]
      expect(hostCookieCall).not.toHaveProperty('domain')
      expect(cookiesSetMock).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'AEC' }))
    } finally {
      restorePlatform(descriptor, originalPlatform)
    }
  })
})

describe('selectBrowserProfile', () => {
  let originalHome: string | undefined
  let tmpDir: string

  beforeEach(() => {
    originalHome = process.env.HOME
    tmpDir = mkdtempSync(join(tmpdir(), 'orca-browser-profile-test-'))
    process.env.HOME = tmpDir
  })

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('selects Firefox and Chromium profiles only when a cookies DB exists', () => {
    const firefoxProfile = join(
      tmpDir,
      'Library',
      'Application Support',
      'Firefox',
      'Profiles',
      'abc.default'
    )
    mkdirSync(firefoxProfile, { recursive: true })
    writeFileSync(join(firefoxProfile, 'cookies.sqlite'), '')

    expect(
      selectBrowserProfile(
        {
          family: 'firefox',
          label: 'Firefox',
          cookiesPath: '/old/path',
          profiles: [{ name: 'default', directory: 'abc.default' }],
          selectedProfile: 'old'
        },
        'abc.default'
      )
    ).toMatchObject({
      cookiesPath: join(firefoxProfile, 'cookies.sqlite'),
      selectedProfile: 'abc.default'
    })

    const chromeProfile = join(
      tmpDir,
      'Library',
      'Application Support',
      'Google',
      'Chrome',
      'Profile 1',
      'Network'
    )
    mkdirSync(chromeProfile, { recursive: true })
    writeFileSync(join(chromeProfile, 'Cookies'), '')

    expect(
      selectBrowserProfile(
        {
          family: 'chrome',
          label: 'Google Chrome',
          keychainService: 'Chrome Safe Storage',
          keychainAccount: 'Chrome',
          cookiesPath: '/old/path',
          profiles: [{ name: 'Profile 1', directory: 'Profile 1' }],
          selectedProfile: 'Default'
        },
        'Profile 1'
      )
    ).toMatchObject({ cookiesPath: join(chromeProfile, 'Cookies'), selectedProfile: 'Profile 1' })
  })
})
