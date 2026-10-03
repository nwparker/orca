import { describe, expect, it, vi } from 'vitest'
import { createSessionSearchClient, unavailableSessionSearchStatus } from './ai-vault-search-client'
import { AiVaultSearchRequestSchema as LegacyRequestSchema } from './__fixtures__/pre-qoder-search-request'
import { searchHit, searchResults } from './ai-vault-search-test-fixture'

describe('Qoder search negotiation', () => {
  it('keeps the frozen old parser closed to Qoder', () => {
    expect(
      LegacyRequestSchema.safeParse({ query: 'q', filters: { agents: ['qoder'] } }).success
    ).toBe(false)
  })

  it.each(['runtime', 'relay'] as const)(
    'sends no search request for sole unsupported Qoder over %s',
    async (transport) => {
      const search = vi.fn((params: unknown) => {
        LegacyRequestSchema.parse(params)
        return searchResults()
      })
      const status = vi.fn(() => unavailableSessionSearchStatus())
      const client = createSessionSearchClient(
        async (method, params) => (method === 'aiVault.searchStatus' ? status() : search(params)),
        transport
      )
      expect(await client.searchSessions({ query: 'q', filters: { agents: ['qoder'] } })).toEqual({
        kind: 'unavailable',
        reason: 'unsupported-agent'
      })
      expect(status).toHaveBeenCalledTimes(1)
      expect(search).not.toHaveBeenCalled()
    }
  )

  it.each(['runtime', 'relay'] as const)(
    'retains every non-Qoder filter through the actual old enum over %s',
    async (transport) => {
      const request = {
        query: 'q',
        scope: 'conversation' as const,
        limit: 42,
        cursor: 'page-1',
        debug: true,
        filters: {
          agents: ['qoder', 'codex', 'claude'] as const,
          scopePaths: ['/host/folder'],
          since: '2026-08-01T00:00:00Z',
          sort: 'newest' as const
        }
      }
      const search = vi.fn((params: unknown) => {
        expect(LegacyRequestSchema.parse(params)).toEqual({
          ...request,
          filters: { ...request.filters, agents: ['codex', 'claude'] }
        })
        return searchResults()
      })
      const client = createSessionSearchClient(
        async (method, params) =>
          method === 'aiVault.searchStatus' ? unavailableSessionSearchStatus() : search(params),
        transport
      )
      await client.searchSessions({
        ...request,
        filters: { ...request.filters, agents: [...request.filters.agents] }
      })
      expect(search).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['runtime', 'relay'] as const)(
    'preserves Qoder identity only after positive host attestation over %s',
    async (transport) => {
      const call = vi.fn(async (method: string) =>
        method === 'aiVault.searchStatus'
          ? { ...unavailableSessionSearchStatus(), supportsQoderHistory: true }
          : { ...searchResults(), hits: [{ ...searchHit(), agent: 'qoder' }] }
      )
      const result = await createSessionSearchClient(call, transport).searchSessions({
        query: 'q',
        filters: { agents: ['qoder'] }
      })
      expect(call.mock.calls.map(([method]) => method)).toEqual([
        'aiVault.searchStatus',
        'aiVault.searchSessions'
      ])
      expect(call).toHaveBeenLastCalledWith('aiVault.searchSessions', {
        query: 'q',
        limit: 20,
        filters: { agents: ['qoder'] },
        includeDshHistory: true,
        includeReasonixHistory: true,
        supportsQoderHistory: true
      })
      expect(result).toMatchObject({ kind: 'results', hits: [{ agent: 'qoder' }] })
    }
  )

  it('does not gate local IPC before the per-host aggregator negotiates', async () => {
    const call = vi.fn(async () => searchResults())
    await createSessionSearchClient(call, 'ipc').searchSessions({
      query: 'q',
      filters: { agents: ['qoder'] }
    })
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchSessions', {
      query: 'q',
      limit: 20,
      filters: { agents: ['qoder'] },
      includeDshHistory: true,
      includeReasonixHistory: true,
      supportsQoderHistory: true
    })
  })

  it('does not dispatch a search when the capability probe loses host contact', async () => {
    const call = vi.fn(async () => {
      throw new Error('host disconnected')
    })
    await expect(
      createSessionSearchClient(call, 'relay').searchSessions({
        query: 'q',
        filters: { agents: ['qoder', 'codex'] }
      })
    ).rejects.toThrow('host disconnected')
    expect(call).toHaveBeenCalledExactlyOnceWith('aiVault.searchStatus', {})
  })

  it.each([
    { dshHistory: false, reasonixHistory: false, supportsQoderHistory: false, agents: ['codex'] },
    {
      dshHistory: true,
      reasonixHistory: false,
      supportsQoderHistory: false,
      agents: ['dsh', 'codex']
    },
    {
      dshHistory: false,
      reasonixHistory: true,
      supportsQoderHistory: false,
      agents: ['reasonix', 'codex']
    },
    {
      dshHistory: false,
      reasonixHistory: false,
      supportsQoderHistory: true,
      agents: ['qoder', 'codex']
    },
    {
      dshHistory: true,
      reasonixHistory: true,
      supportsQoderHistory: true,
      agents: ['reasonix', 'dsh', 'qoder', 'codex']
    }
  ])('negotiates independent history capabilities in one probe: $agents', async (capabilities) => {
    for (const transport of ['runtime', 'relay'] as const) {
      const { agents, ...advertised } = capabilities
      const call = vi.fn(async (method: string) =>
        method === 'aiVault.searchStatus'
          ? { ...unavailableSessionSearchStatus(), ...advertised }
          : searchResults()
      )
      await createSessionSearchClient(call, transport).searchSessions({
        query: 'needle',
        limit: 1,
        cursor: 'next-page',
        filters: { agents: ['reasonix', 'dsh', 'qoder', 'codex'], scopePaths: ['/host/folder'] }
      })
      expect(call.mock.calls.map(([method]) => method)).toEqual([
        'aiVault.searchStatus',
        'aiVault.searchSessions'
      ])
      expect(call).toHaveBeenLastCalledWith('aiVault.searchSessions', {
        query: 'needle',
        limit: 1,
        cursor: 'next-page',
        filters: { agents, scopePaths: ['/host/folder'] },
        includeDshHistory: true,
        includeReasonixHistory: true,
        supportsQoderHistory: true
      })
    }
  })
})
