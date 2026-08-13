import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GithubEnterpriseRepositoryModule from './github-enterprise-repository'
import type * as GhUtils from './gh-utils'

const {
  ghExecFileAsyncMock,
  getIssueOwnerRepoMock,
  resolveIssueSourceMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', async () => {
  const actual = await vi.importActual<typeof GhUtils>('./gh-utils')
  return {
    ...actual,
    ghExecFileAsync: ghExecFileAsyncMock,
    getIssueOwnerRepo: getIssueOwnerRepoMock,
    resolveIssueSource: resolveIssueSourceMock,
    acquire: acquireMock,
    release: releaseMock
  }
})

vi.mock('./github-enterprise-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubEnterpriseRepositoryModule>()),
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

vi.mock('./github-api-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubApiRepositoryModule>()
  const withDotComHost = <T extends { host?: string } | null | undefined>(repo: T) =>
    repo ? { host: 'github.com' as const, ...repo } : repo
  return {
    ...actual,
    // Why: these suites drive source resolution through the legacy gh-utils
    // mocks; bridge the hosted seams onto the same mocks and pin github.com so
    // host-less fixtures still pass resolveGitHubApiRepository's host gate.
    getIssueGitHubApiRepository: async (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => withDotComHost(await getIssueOwnerRepoMock(repoPath, connectionId, localGitOptions)),
    resolveIssueGitHubApiRepositorySource: async (
      repoPath: string,
      preference: unknown,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => {
      const result = await resolveIssueSourceMock(
        repoPath,
        preference,
        connectionId,
        localGitOptions
      )
      return {
        ...result,
        source: withDotComHost(result?.source)
      }
    }
  }
})

import {
  addIssueComment,
  createIssue,
  getIssue,
  listAssignableUsers,
  listIssues,
  listLabels,
  updateIssue
} from './issues'

import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

function githubIssuePayload(number: number): Record<string, unknown> {
  return {
    number,
    title: `Issue ${number}`,
    state: 'open',
    html_url: `https://github.com/stablyai/orca/issues/${number}`,
    labels: []
  }
}

// The origin-repository cache is module-level state; reset it so slugs
// resolved by one test cannot leak into the next.
beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

describe('issue source operations', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    resolveIssueSourceMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    // Why: preference-aware paths call resolveIssueSource instead of
    // getIssueOwnerRepo. Route through the same mock so existing tests that
    // set up getIssueOwnerRepoMock continue to work.
    resolveIssueSourceMock.mockImplementation(async () => ({
      source: await getIssueOwnerRepoMock(),
      fellBack: false
    }))
  })

  it('gets a single issue from the issue owner/repo', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 923,
        title: 'Use upstream issues',
        state: 'open',
        html_url: 'https://github.com/stablyai/orca/issues/923',
        labels: [],
        body: 'The issue body'
      })
    })

    await expect(getIssue('/repo-root', 923)).resolves.toMatchObject({
      number: 923,
      description: 'The issue body'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '--cache', '300s', 'repos/stablyai/orca/issues/923'],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('routes local WSL issue operations through repo resolution and gh execution options', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    resolveIssueSourceMock.mockResolvedValue({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 923,
          title: 'Use upstream issues',
          state: 'open',
          html_url: 'https://github.com/stablyai/orca/issues/923',
          labels: []
        })
      })
      .mockResolvedValueOnce({ stdout: '[]' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 924,
          html_url: 'https://github.com/stablyai/orca/issues/924'
        })
      })
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 1,
          user: { login: 'octo', avatar_url: '', type: 'User' },
          body: 'Comment',
          created_at: '2026-06-16T00:00:00.000Z',
          html_url: 'https://github.com/stablyai/orca/issues/923#issuecomment-1'
        })
      })
      .mockResolvedValueOnce({ stdout: 'bug\nfrontend\n' })
      .mockResolvedValueOnce({ stdout: '{"login":"octo","avatar_url":""}\n' })

    await getIssue('/repo-root', 923, null, localGitOptions)
    await listIssues('/repo-root', 5, undefined, null, localGitOptions)
    await createIssue(
      '/repo-root',
      'New issue',
      'Body',
      undefined,
      null,
      undefined,
      localGitOptions
    )
    await updateIssue('/repo-root', 923, { body: 'Updated' }, null, localGitOptions)
    await addIssueComment('/repo-root', 923, 'Comment', null, null, localGitOptions)
    await listLabels('/repo-root', undefined, null, localGitOptions)
    await listAssignableUsers('/repo-root', undefined, null, localGitOptions)

    expect(getIssueOwnerRepoMock).toHaveBeenCalledWith('/repo-root', null, localGitOptions)
    expect(resolveIssueSourceMock).toHaveBeenCalledWith(
      '/repo-root',
      undefined,
      null,
      localGitOptions
    )
    expect(ghExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
  })

  it('routes PR conversation comments to the supplied Enterprise host', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        id: 9,
        node_id: 'IC_enterprise_9',
        user: { login: 'octo', avatar_url: '', type: 'User' },
        body: 'Enterprise comment',
        created_at: '2026-07-16T00:00:00.000Z',
        html_url: 'https://github.acme-corp.com/team/orca/pull/7#issuecomment-9'
      })
    })

    await expect(
      addIssueComment('/remote/repo', 7, 'Enterprise comment', 'ssh-1', {
        owner: 'team',
        repo: 'orca',
        host: 'github.acme-corp.com'
      })
    ).resolves.toMatchObject({
      ok: true,
      comment: { reactionSubjectId: 'IC_enterprise_9' }
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '-X',
        'POST',
        'repos/team/orca/issues/7/comments',
        '--raw-field',
        'body=Enterprise comment'
      ],
      expect.objectContaining({ host: 'github.acme-corp.com' })
    )
  })

  it('lists issues from the issue owner/repo', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '[]' })

    await expect(listIssues('/repo-root', 5)).resolves.toEqual({ items: [] })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '--cache',
        '120s',
        'repos/stablyai/orca/issues?per_page=100&page=1&state=open&sort=updated&direction=desc'
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('continues past a full page of pull requests to collect issues', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    const pullRequests = Array.from({ length: 100 }, (_, index) => ({
      ...githubIssuePayload(index + 1),
      pull_request: {}
    }))
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(pullRequests) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([githubIssuePayload(101), githubIssuePayload(102)])
      })

    const result = await listIssues('/repo-root', 2)

    expect(result.items.map((issue) => issue.number)).toEqual([101, 102])
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'api',
        '--cache',
        '120s',
        'repos/stablyai/orca/issues?per_page=100&page=2&state=open&sort=updated&direction=desc'
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('fills the requested issue count across mixed GitHub pages', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    const firstPage = [
      githubIssuePayload(1),
      ...Array.from({ length: 99 }, (_, index) => ({
        ...githubIssuePayload(index + 100),
        pull_request: {}
      }))
    ]
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(firstPage) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          githubIssuePayload(2),
          githubIssuePayload(3),
          githubIssuePayload(4)
        ])
      })

    const result = await listIssues('/repo-root', 3)

    expect(result.items.map((issue) => issue.number)).toEqual([1, 2, 3])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('deduplicates issues that move across page boundaries', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    const firstPage = [
      githubIssuePayload(1),
      ...Array.from({ length: 99 }, (_, index) => ({
        ...githubIssuePayload(index + 100),
        pull_request: {}
      }))
    ]
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(firstPage) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([githubIssuePayload(1), githubIssuePayload(2)])
      })

    const result = await listIssues('/repo-root', 2)

    expect(result.items.map((issue) => issue.number)).toEqual([1, 2])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('stops issue pagination after a short GitHub page', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        { ...githubIssuePayload(1), pull_request: {} },
        githubIssuePayload(2)
      ])
    })

    const result = await listIssues('/repo-root', 3)

    expect(result.items.map((issue) => issue.number)).toEqual([2])
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('threads Enterprise host and WSL options through every issue page', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    resolveIssueSourceMock.mockResolvedValueOnce({
      source: { owner: 'team', repo: 'orca', host: 'github.acme-corp.com' },
      fellBack: false
    })
    const pullRequests = Array.from({ length: 100 }, (_, index) => ({
      ...githubIssuePayload(index + 1),
      pull_request: {}
    }))
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(pullRequests) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([githubIssuePayload(101)]) })

    await listIssues('/repo-root', 1, undefined, null, localGitOptions)

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(
      ghExecFileAsyncMock.mock.calls.every(
        (call) => call[1]?.host === 'github.acme-corp.com' && call[1]?.wslDistro === 'Ubuntu'
      )
    ).toBe(true)
  })

  it('returns no GitHub issues without requesting a page for a nonpositive limit', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })

    await expect(listIssues('/repo-root', 0)).resolves.toEqual({ items: [] })

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('surfaces a classified permission_denied error instead of collapsing to empty', async () => {
    // Why: parent design doc §3 — a 403 on a private upstream must not
    // masquerade as "No issues". The envelope carries an error the UI can
    // render as a banner with retry, not a silent empty list.
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('gh exited with 1.'), {
        stderr: 'HTTP 403: Resource not accessible by integration'
      })
    )

    const result = await listIssues('/repo-root', 5)

    expect(result.items).toEqual([])
    expect(result.error?.type).toBe('permission_denied')
  })

  it('creates issues in the issue owner/repo', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 924,
        html_url: 'https://github.com/stablyai/orca/issues/924'
      })
    })

    await expect(createIssue('/repo-root', 'New issue', 'Body')).resolves.toEqual({
      ok: true,
      number: 924,
      url: 'https://github.com/stablyai/orca/issues/924'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '-X',
        'POST',
        'repos/stablyai/orca/issues',
        '--raw-field',
        'title=New issue',
        '--raw-field',
        'body=Body'
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('creates issues with labels and assignees', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 925,
        html_url: 'https://github.com/stablyai/orca/issues/925'
      })
    })

    await expect(
      createIssue('/repo-root', 'New issue', 'Body', undefined, undefined, {
        labels: ['bug', 'frontend'],
        assignees: ['octo']
      })
    ).resolves.toEqual({
      ok: true,
      number: 925,
      url: 'https://github.com/stablyai/orca/issues/925'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'api',
        '-X',
        'POST',
        'repos/stablyai/orca/issues',
        '--raw-field',
        'title=New issue',
        '--raw-field',
        'body=Body',
        '--raw-field',
        'labels[]=bug',
        '--raw-field',
        'labels[]=frontend',
        '--raw-field',
        'assignees[]=octo'
      ],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('recovers issue 7704 oversized inline-image creation', async () => {
    const imagePrefix = 'data:image/png;base64,'
    const body = imagePrefix + 'x'.repeat(133596 - imagePrefix.length)
    expect(body).toContain('data:image')
    expect(body).toHaveLength(133596)

    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 422: body is too long (maximum is 65536 characters)'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 926,
          html_url: 'https://github.com/stablyai/orca/issues/926'
        })
      })
      .mockResolvedValueOnce({ stdout: '' })

    await expect(
      createIssue('/repo-root', 'Image issue', body, undefined, undefined, {
        labels: ['bug'],
        assignees: ['octo']
      })
    ).resolves.toEqual({
      ok: true,
      number: 926,
      url: 'https://github.com/stablyai/orca/issues/926'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      expect.arrayContaining([
        `body=${body}`,
        'title=Image issue',
        'labels[]=bug',
        'assignees[]=octo'
      ]),
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(['body=', 'title=Image issue', 'labels[]=bug', 'assignees[]=octo']),
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', '-X', 'PATCH', 'repos/stablyai/orca/issues/926', '--raw-field', `body=${body}`],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('recognizes the oversized-body response from structured gh stderr', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(
        Object.assign(new Error('Command failed: gh'), {
          stderr: 'gh: body is too long (maximum is 65536 characters) (HTTP 422)'
        })
      )
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 929,
          html_url: 'https://github.com/stablyai/orca/issues/929'
        })
      })
      .mockResolvedValueOnce({ stdout: '' })

    await expect(createIssue('/repo-root', 'Image issue', 'data:image')).resolves.toEqual({
      ok: true,
      number: 929,
      url: 'https://github.com/stablyai/orca/issues/929'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

  it('does not retry unrelated create failures', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 422: assignees is invalid'))

    await expect(createIssue('/repo-root', 'Invalid issue', 'Body')).resolves.toEqual({
      ok: false,
      error: 'HTTP 422: assignees is invalid'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('stops when placeholder create fails during oversized-body recovery', async () => {
    const body = `data:image/png;base64,${'x'.repeat(100)}`
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('body is too long (maximum is 65536 characters)'))
      .mockRejectedValueOnce(new Error('HTTP 500: create failed'))

    await expect(createIssue('/repo-root', 'Placeholder failure', body)).resolves.toEqual({
      ok: false,
      error: 'HTTP 500: create failed'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('preserves fields during oversized-body recovery', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    const body = `data:image/png;base64,${'x'.repeat(100)}`
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('body is too long (maximum is 65536 characters)'))
      .mockResolvedValueOnce({ stdout: JSON.stringify({ number: 927, url: 'issue-url' }) })
      .mockResolvedValueOnce({ stdout: '' })

    await expect(
      createIssue(
        '/repo-root',
        'Fields issue',
        body,
        undefined,
        null,
        {
          labels: ['bug'],
          assignees: ['octo']
        },
        localGitOptions
      )
    ).resolves.toEqual({ ok: true, number: 927, url: 'issue-url' })
    const firstCreateArgs = [...ghExecFileAsyncMock.mock.calls[0][0]]
    const fallbackCreateArgs = [...ghExecFileAsyncMock.mock.calls[1][0]]
    firstCreateArgs[firstCreateArgs.indexOf(`body=${body}`)] = 'body='
    expect(fallbackCreateArgs).toEqual(firstCreateArgs)
    expect(ghExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
    expect(resolveIssueSourceMock).toHaveBeenCalledWith(
      '/repo-root',
      undefined,
      null,
      localGitOptions
    )
  })

  it('reports partial success when oversized-body patch fails', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('body is too long (maximum is 65536 characters)'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 928,
          html_url: 'https://github.com/stablyai/orca/issues/928'
        })
      })
      .mockRejectedValueOnce(new Error('HTTP 500: update failed'))

    await expect(createIssue('/repo-root', 'Partial issue', 'data:image')).resolves.toEqual({
      ok: true,
      number: 928,
      url: 'https://github.com/stablyai/orca/issues/928',
      bodySaveWarning:
        'Issue https://github.com/stablyai/orca/issues/928 was created, but saving its body failed: HTTP 500: update failed'
    })
  })

  it('updates issue body through the REST issue endpoint', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(updateIssue('/repo-root', 924, { body: 'Updated body' })).resolves.toEqual({
      ok: true
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', '-X', 'PATCH', 'repos/stablyai/orca/issues/924', '--raw-field', 'body=Updated body'],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('classifies structured gh permission diagnostics for issue mutations', async () => {
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('gh exited with 1.'), {
        stderr: 'HTTP 403: Resource not accessible by integration'
      })
    )

    const updateResult = await updateIssue('/repo-root', 924, { body: 'Updated body' })
    const commentResult = await addIssueComment('/repo-root', 924, 'Comment')

    expect(updateResult).toEqual({
      ok: false,
      error: "You don't have permission to edit this issue. Check your GitHub token scopes."
    })
    expect(commentResult).toEqual({
      ok: false,
      error: "You don't have permission to edit this issue. Check your GitHub token scopes."
    })
  })

  it('treats structured already-closed and already-open diagnostics as success', async () => {
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(
        Object.assign(new Error('gh exited with 1.'), { stderr: 'issue is already closed' })
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('gh exited with 1.'), { stderr: 'issue is already open' })
      )

    await expect(updateIssue('/repo-root', 924, { state: 'closed' })).resolves.toEqual({
      ok: true
    })
    await expect(updateIssue('/repo-root', 924, { state: 'open' })).resolves.toEqual({ ok: true })
  })

  it('closes issues with completed, not planned, and duplicate reasons', async () => {
    getIssueOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '' })

    await expect(
      updateIssue('/repo-root', 924, { state: 'closed', stateReason: 'completed' })
    ).resolves.toEqual({ ok: true })
    await expect(
      updateIssue('/repo-root', 925, { state: 'closed', stateReason: 'not_planned' })
    ).resolves.toEqual({ ok: true })
    await expect(
      updateIssue('/repo-root', 926, {
        state: 'closed',
        stateReason: 'duplicate',
        duplicateOf: 99
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['issue', 'close', '924', '--repo', 'stablyai/orca', '--reason', 'completed'],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['issue', 'close', '925', '--repo', 'stablyai/orca', '--reason', 'not planned'],
      { cwd: '/repo-root', host: 'github.com' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['issue', 'close', '926', '--repo', 'stablyai/orca', '--duplicate-of', '99'],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })

  it('reopens issues through gh issue reopen', async () => {
    getIssueOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '' })

    await expect(updateIssue('/repo-root', 924, { state: 'open' })).resolves.toEqual({
      ok: true
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['issue', 'reopen', '924', '--repo', 'stablyai/orca'],
      { cwd: '/repo-root', host: 'github.com' }
    )
  })
})
