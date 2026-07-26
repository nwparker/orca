import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  acquireMock,
  releaseMock,
  ghExecFileAsyncMock,
  getWorkItemMock,
  getPRCommentsMock,
  getPRChecksMock
} = vi.hoisted(() => ({
  acquireMock: vi.fn<() => Promise<void>>(),
  releaseMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getWorkItemMock: vi.fn(),
  getPRCommentsMock: vi.fn(),
  getPRChecksMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  acquire: acquireMock,
  release: releaseMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  ghRepoExecOptions: (context: { repoPath: string }) => ({ cwd: context.repoPath }),
  githubRepoContext: (repoPath: string, connectionId?: string | null) => ({
    repoPath,
    connectionId: connectionId ?? null
  })
}))

vi.mock('./client', () => ({
  getWorkItem: getWorkItemMock,
  getPRComments: getPRCommentsMock,
  getPRChecks: getPRChecksMock
}))

vi.mock('./github-api-repository', () => ({
  getIssueGitHubApiRepository: vi.fn(),
  getOriginGitHubApiRepository: vi.fn(),
  githubHostExecOptions: (repository?: { host?: string } | null) =>
    repository?.host ? { host: repository.host } : {},
  // Why: getWorkItemDetails awaits resolveGitHubRepoExecution and reads .ownerRepo.
  resolveGitHubRepoExecution: vi.fn(
    async (
      _repoPath: string,
      repository?: { owner: string; repo: string; host?: string } | null
    ) => ({
      ownerRepo: repository ?? { owner: 'acme', repo: 'widgets', host: 'github.com' },
      ghOptions: {
        cwd: '/repo',
        host: repository?.host ?? 'github.com'
      }
    })
  )
}))

vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn()
}))

import { getWorkItemDetails } from './work-item-details'

describe('getWorkItemDetails PR file pagination', () => {
  let filePageRequests: string[]

  beforeEach(() => {
    filePageRequests = []
    acquireMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    releaseMock.mockReset()

    getPRCommentsMock.mockReset()
    getPRCommentsMock.mockResolvedValue([])
    getPRChecksMock.mockReset()
    getPRChecksMock.mockResolvedValue([])

    ghExecFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (query.includes('viewerViewedState')) {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  id: 'PR_id',
                  files: { pageInfo: { hasNextPage: false }, nodes: [] }
                }
              }
            }
          })
        }
      }
      if (query.includes('participants')) {
        return {
          stdout: JSON.stringify({
            data: { repository: { pullRequest: { participants: { nodes: [] } } } }
          })
        }
      }
      const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
      if (endpoint.includes('/files?')) {
        filePageRequests.push(endpoint)
        const pageMatch = endpoint.match(/[&?]page=(\d+)/)
        const page = pageMatch ? Number(pageMatch[1]) : 1
        const total = filesForCurrentPr
        const start = (page - 1) * 100
        const count = Math.max(0, Math.min(100, total - start))
        return {
          stdout: JSON.stringify(
            Array.from({ length: count }, (_value, index) => ({
              filename: `src/file-${start + index}.ts`,
              status: 'modified',
              additions: 1,
              deletions: 0
            }))
          )
        }
      }
      if (/\/pulls\/\d+$/.test(endpoint)) {
        return {
          stdout: JSON.stringify({ body: 'body', head: { sha: 'head' }, base: { sha: 'base' } })
        }
      }
      return { stdout: JSON.stringify({ data: {} }) }
    })
  })

  let filesForCurrentPr = 0

  function mockWorkItem(changedFiles: number | undefined): void {
    getWorkItemMock.mockReset()
    getWorkItemMock.mockImplementation(async (_repoPath: string, number: number) => ({
      id: `pr:${number}`,
      type: 'pr',
      number,
      title: `PR ${number}`,
      state: 'open',
      url: `https://github.com/acme/widgets/pull/${number}`,
      labels: [],
      updatedAt: '2026-07-16T00:00:00Z',
      author: null,
      prRepo: { owner: 'acme', repo: 'widgets', host: 'github.com' },
      ...(changedFiles === undefined ? {} : { changedFiles })
    }))
  }

  // Why these counts: each page is a separate `gh api` spawn plus a network round
  // trip, and the old probe loop spent one extra whenever the file count landed on
  // an exact page boundary.
  it('spends one request per page when the changed-file count is known', async () => {
    filesForCurrentPr = 100
    mockWorkItem(100)

    const details = await getWorkItemDetails('/repo', 7, 'pr')

    expect(details?.files).toHaveLength(100)
    expect(filePageRequests).toHaveLength(1)
  })

  it('fans out multi-page reads instead of probing serially', async () => {
    filesForCurrentPr = 200
    mockWorkItem(200)

    const details = await getWorkItemDetails('/repo', 8, 'pr')

    expect(details?.files).toHaveLength(200)
    expect(filePageRequests).toHaveLength(2)
    expect(filePageRequests.some((endpoint) => endpoint.includes('page=2'))).toBe(true)
  })

  it('caps at MAX_PR_FILES even when the count is larger', async () => {
    filesForCurrentPr = 900
    mockWorkItem(900)

    const details = await getWorkItemDetails('/repo', 9, 'pr')

    expect(details?.files).toHaveLength(300)
    expect(filePageRequests).toHaveLength(3)
  })

  it('falls back to serial probing when the count is unknown', async () => {
    filesForCurrentPr = 150
    mockWorkItem(undefined)

    const details = await getWorkItemDetails('/repo', 10, 'pr')

    expect(details?.files).toHaveLength(150)
    // Serial probe: page 1 is full, page 2 is short and terminates the loop.
    expect(filePageRequests).toHaveLength(2)
  })
})
