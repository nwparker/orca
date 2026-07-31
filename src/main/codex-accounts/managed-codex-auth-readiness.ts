import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import type { GlobalSettings } from '../../shared/types'
import type { CodexAccountSelectionTarget } from './runtime-selection'

const AUTH_READY_TIMEOUT_MS = 1_500
const AUTH_READY_RETRY_MS = 25

type StoredCodexAuth = {
  auth_mode?: unknown
  OPENAI_API_KEY?: unknown
  agent_identity?: unknown
  last_refresh?: unknown
  tokens?: {
    access_token?: unknown
    id_token?: unknown
    refresh_token?: unknown
    account_id?: unknown
  } | null
}

export function waitForManagedCodexAuthReady(args: {
  codexHomePath: string | null
  settings: GlobalSettings | undefined
  target: CodexAccountSelectionTarget
}): Promise<void> | undefined {
  if (
    args.target.runtime !== 'host' ||
    !args.codexHomePath ||
    !isManagedHostCodexHome(args.codexHomePath, args.settings)
  ) {
    return
  }

  const authPath = join(args.codexHomePath, 'auth.json')
  if (hasStoredCodexCredential(authPath)) {
    return
  }
  return waitForStoredCodexCredential(authPath)
}

async function waitForStoredCodexCredential(authPath: string): Promise<void> {
  const deadline = Date.now() + AUTH_READY_TIMEOUT_MS
  do {
    await delay(AUTH_READY_RETRY_MS)
    if (hasStoredCodexCredential(authPath)) {
      return
    }
  } while (Date.now() < deadline)

  throw new Error(
    'The selected Codex account credentials are temporarily unavailable. Try opening the terminal again.'
  )
}

function isManagedHostCodexHome(
  codexHomePath: string,
  settings: GlobalSettings | undefined
): boolean {
  const expected = normalizeRuntimePathForComparison(codexHomePath)
  return (
    settings?.codexManagedAccounts?.some(
      (account) =>
        account.managedHomeRuntime !== 'wsl' &&
        normalizeRuntimePathForComparison(account.managedHomePath) === expected
    ) === true
  )
}

function hasStoredCodexCredential(authPath: string): boolean {
  try {
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as StoredCodexAuth
    if (!hasValidStoredAuthShape(auth)) {
      return false
    }
    if (auth.auth_mode === 'apikey' || (!auth.auth_mode && auth.OPENAI_API_KEY != null)) {
      return isNonEmptyString(auth.OPENAI_API_KEY)
    }
    if (auth.auth_mode === 'agentIdentity') {
      return isNonEmptyString(auth.agent_identity)
    }
    return hasChatGptCredential(auth)
  } catch {
    return false
  }
}

function hasValidStoredAuthShape(auth: StoredCodexAuth): boolean {
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
    return false
  }
  if (
    !isOptionalString(auth.OPENAI_API_KEY) ||
    !isOptionalString(auth.agent_identity) ||
    !isOptionalString(auth.last_refresh) ||
    !isValidAuthMode(auth.auth_mode)
  ) {
    return false
  }
  const tokens = auth.tokens
  return (
    tokens == null ||
    (typeof tokens === 'object' &&
      !Array.isArray(tokens) &&
      typeof tokens.access_token === 'string' &&
      typeof tokens.id_token === 'string' &&
      typeof tokens.refresh_token === 'string' &&
      isOptionalString(tokens.account_id))
  )
}

function isValidAuthMode(value: unknown): boolean {
  return (
    value == null ||
    value === 'apikey' ||
    value === 'chatgpt' ||
    value === 'chatgptAuthTokens' ||
    value === 'agentIdentity'
  )
}

function hasChatGptCredential(auth: StoredCodexAuth): boolean {
  return (
    isNonEmptyString(auth.tokens?.access_token) &&
    isNonEmptyString(auth.tokens?.id_token) &&
    isNonEmptyString(auth.tokens?.refresh_token)
  )
}

function isOptionalString(value: unknown): boolean {
  return value == null || typeof value === 'string'
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
