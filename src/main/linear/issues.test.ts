/* eslint-disable max-lines -- Why: Linear issue API coverage shares one client
   mock across list/search/get/create/comment/update paths. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  addIssueComment,
  createIssue,
  getIssue,
  getIssueComments,
  listIssues,
  searchIssues,
  updateIssue
} from './issues'
import { getTeamLabels, getTeamMembers, getTeamStates, listTeams } from './teams'
import { mapLinearIssue } from './mappers'

const linearMock = vi.hoisted(() => ({
  client: null as Record<string, unknown> | null,
  acquire: vi.fn(async () => undefined),
  release: vi.fn(),
  clearToken: vi.fn(),
  isAuthError: vi.fn((error: unknown) => Boolean((error as { auth?: boolean })?.auth))
}))

vi.mock('./client', () => ({
  acquire: linearMock.acquire,
  release: linearMock.release,
  getClient: vi.fn(() => linearMock.client),
  getClients: vi.fn(() =>
    linearMock.client
      ? [
          {
            workspace: { id: 'workspace-1', organizationName: 'Workspace One' },
            client: linearMock.client
          }
        ]
      : []
  ),
  isAuthError: linearMock.isAuthError,
  clearToken: linearMock.clearToken
}))

vi.mock('./mappers', () => ({
  mapLinearIssue: vi.fn(async (issue: { id: string; title?: string }) => ({
    id: issue.id,
    identifier: issue.id,
    title: issue.title ?? issue.id,
    url: `https://linear.test/${issue.id}`
  }))
}))

describe('Linear issue and team services', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    linearMock.client = null
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('returns empty disconnected results without acquiring the API limiter', async () => {
    await expect(getIssue('ISS-1')).resolves.toBeNull()
    await expect(searchIssues('bug')).resolves.toEqual([])
    await expect(listIssues()).resolves.toEqual([])
    await expect(createIssue('team-1', 'Title')).resolves.toEqual({
      ok: false,
      error: 'Not connected to Linear'
    })
    await expect(updateIssue('ISS-1', { title: 'Updated' })).resolves.toEqual({
      ok: false,
      error: 'Not connected to Linear'
    })
    await expect(addIssueComment('ISS-1', 'Body')).resolves.toEqual({
      ok: false,
      error: 'Not connected to Linear'
    })
    await expect(getIssueComments('ISS-1')).resolves.toEqual([])
    await expect(listTeams()).resolves.toEqual([])
    await expect(getTeamStates('team-1')).resolves.toEqual([])
    await expect(getTeamLabels('team-1')).resolves.toEqual([])
    await expect(getTeamMembers('team-1')).resolves.toEqual([])
    expect(linearMock.acquire).not.toHaveBeenCalled()
  })

  it('maps issue reads, searches, list filters, and comments', async () => {
    const viewer = {
      assignedIssues: vi.fn(async () => ({
        nodes: [
          { id: 'ASSIGNED-1', title: 'Assigned' },
          { id: 'ASSIGNED-2', title: 'Assigned Two' }
        ]
      })),
      createdIssues: vi.fn(async () => ({
        nodes: [{ id: 'CREATED-1', title: 'Created' }]
      }))
    }
    const issueWithComments = {
      id: 'ISS-1',
      title: 'One',
      comments: vi.fn(async () => ({
        nodes: [
          {
            id: 'comment-1',
            body: 'First',
            createdAt: new Date('2026-01-02T03:04:05.000Z'),
            user: Promise.resolve({ displayName: 'Ada', avatarUrl: null })
          },
          {
            id: 'comment-2',
            body: 'Second',
            createdAt: new Date('2026-01-03T03:04:05.000Z'),
            user: Promise.resolve(null)
          }
        ]
      }))
    }
    linearMock.client = {
      issue: vi.fn(async () => issueWithComments),
      searchIssues: vi.fn(async () => ({
        nodes: [{ id: 'SEARCH-1', title: 'Search Result' }]
      })),
      issues: vi.fn(async () => ({ nodes: [{ id: 'ALL-1', title: 'All' }] })),
      viewer: Promise.resolve(viewer)
    }

    await expect(getIssue('ISS-1')).resolves.toMatchObject({ id: 'ISS-1', title: 'One' })
    await expect(searchIssues('bug', 3)).resolves.toEqual([
      expect.objectContaining({ id: 'SEARCH-1', title: 'Search Result' })
    ])
    await expect(listIssues('assigned', 2)).resolves.toHaveLength(2)
    await expect(listIssues('created', 4)).resolves.toEqual([
      expect.objectContaining({ id: 'CREATED-1' })
    ])
    await expect(listIssues('completed', 5)).resolves.toEqual([
      expect.objectContaining({ id: 'ASSIGNED-1' }),
      expect.objectContaining({ id: 'ASSIGNED-2' })
    ])
    await expect(listIssues('all', 6)).resolves.toEqual([expect.objectContaining({ id: 'ALL-1' })])
    await expect(getIssueComments('ISS-1')).resolves.toEqual([
      {
        id: 'comment-1',
        body: 'First',
        createdAt: '2026-01-02T03:04:05.000Z',
        user: { displayName: 'Ada', avatarUrl: undefined }
      },
      {
        id: 'comment-2',
        body: 'Second',
        createdAt: '2026-01-03T03:04:05.000Z',
        user: undefined
      }
    ])

    expect(linearMock.client.searchIssues).toHaveBeenCalledWith('bug', { first: 3 })
    expect(viewer.assignedIssues).toHaveBeenCalledWith(
      expect.objectContaining({ first: 2, orderBy: 'updatedAt' })
    )
    expect(viewer.createdIssues).toHaveBeenCalledWith(
      expect.objectContaining({ first: 4, orderBy: 'updatedAt' })
    )
    expect(linearMock.client.issues).toHaveBeenCalledWith(
      expect.objectContaining({ first: 6, orderBy: 'updatedAt' })
    )
    expect(mapLinearIssue).toHaveBeenCalled()
  })

  it('creates, updates, and comments on issues', async () => {
    linearMock.client = {
      createIssue: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          issue: Promise.resolve({
            id: 'issue-id',
            identifier: 'ISS-1',
            url: 'https://linear.test/ISS-1'
          })
        })
        .mockResolvedValueOnce({ success: false }),
      updateIssue: vi.fn().mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({
        success: false
      }),
      createComment: vi
        .fn()
        .mockResolvedValueOnce({
          success: true,
          comment: Promise.resolve({ id: 'comment-id' })
        })
        .mockResolvedValueOnce({ success: false })
    }

    await expect(createIssue('team-1', 'Title', 'Description')).resolves.toEqual({
      ok: true,
      id: 'issue-id',
      identifier: 'ISS-1',
      url: 'https://linear.test/ISS-1'
    })
    expect(linearMock.client.createIssue).toHaveBeenCalledWith({
      teamId: 'team-1',
      title: 'Title',
      description: 'Description'
    })
    await expect(createIssue('team-1', 'Title')).resolves.toEqual({
      ok: false,
      error: 'Linear create failed'
    })

    await expect(
      updateIssue('ISS-1', {
        stateId: 'state-1',
        title: 'Updated',
        assigneeId: 'user-1',
        priority: 2,
        labelIds: ['label-1']
      })
    ).resolves.toEqual({ ok: true })
    expect(linearMock.client.updateIssue).toHaveBeenCalledWith('ISS-1', {
      stateId: 'state-1',
      title: 'Updated',
      assigneeId: 'user-1',
      priority: 2,
      labelIds: ['label-1']
    })
    await expect(updateIssue('ISS-1', {})).resolves.toEqual({
      ok: false,
      error: 'Linear update failed'
    })

    await expect(addIssueComment('ISS-1', 'Body')).resolves.toEqual({
      ok: true,
      id: 'comment-id'
    })
    await expect(addIssueComment('ISS-1', 'Body')).resolves.toEqual({
      ok: false,
      error: 'Failed to create comment'
    })
  })

  it('sorts and maps team metadata', async () => {
    linearMock.client = {
      teams: vi.fn(async () => ({
        nodes: [
          { id: 'team-b', name: 'Beta', key: 'BET' },
          { id: 'team-a', name: 'Alpha', key: 'ALP' }
        ]
      })),
      team: vi.fn(async () => ({
        states: vi.fn(async () => ({
          nodes: [
            { id: 'state-2', name: 'Done', type: 'completed', color: '#0f0', position: 2 },
            { id: 'state-1', name: 'Todo', type: 'unstarted', color: '#f00', position: 1 }
          ]
        })),
        labels: vi.fn(async () => ({
          nodes: [{ id: 'label-1', name: 'Bug', color: '#f00' }]
        })),
        members: vi.fn(async () => ({
          nodes: [
            { id: 'user-1', displayName: 'Ada', avatarUrl: null },
            { id: 'user-2', displayName: 'Grace', avatarUrl: 'https://example.com/avatar.png' }
          ]
        }))
      }))
    }

    await expect(listTeams()).resolves.toEqual([
      {
        id: 'team-a',
        workspaceId: 'workspace-1',
        workspaceName: 'Workspace One',
        name: 'Alpha',
        key: 'ALP'
      },
      {
        id: 'team-b',
        workspaceId: 'workspace-1',
        workspaceName: 'Workspace One',
        name: 'Beta',
        key: 'BET'
      }
    ])
    await expect(getTeamStates('team-a')).resolves.toEqual([
      { id: 'state-1', name: 'Todo', type: 'unstarted', color: '#f00', position: 1 },
      { id: 'state-2', name: 'Done', type: 'completed', color: '#0f0', position: 2 }
    ])
    await expect(getTeamLabels('team-a')).resolves.toEqual([
      { id: 'label-1', name: 'Bug', color: '#f00' }
    ])
    await expect(getTeamMembers('team-a')).resolves.toEqual([
      { id: 'user-1', displayName: 'Ada', avatarUrl: undefined },
      { id: 'user-2', displayName: 'Grace', avatarUrl: 'https://example.com/avatar.png' }
    ])
  })

  it('clears tokens and rethrows auth failures', async () => {
    const authError = Object.assign(new Error('unauthorized'), { auth: true })
    linearMock.client = {
      issue: vi.fn(async () => {
        throw authError
      })
    }

    await expect(getIssue('ISS-1')).rejects.toThrow('unauthorized')

    expect(linearMock.clearToken).toHaveBeenCalledTimes(1)
    expect(linearMock.release).toHaveBeenCalledTimes(1)
  })

  it('gracefully degrades non-auth failures', async () => {
    linearMock.client = {
      searchIssues: vi.fn(async () => {
        throw new Error('search failed')
      }),
      createIssue: vi.fn(async () => {
        throw new Error('create failed')
      }),
      updateIssue: vi.fn(async () => {
        throw new Error('update failed')
      }),
      createComment: vi.fn(async () => {
        throw new Error('comment failed')
      }),
      issue: vi.fn(async () => {
        throw new Error('comment list failed')
      }),
      teams: vi.fn(async () => {
        throw new Error('teams failed')
      })
    }

    await expect(searchIssues('bug')).resolves.toEqual([])
    await expect(createIssue('team-1', 'Title')).resolves.toEqual({
      ok: false,
      error: 'create failed'
    })
    await expect(updateIssue('ISS-1', { title: 'Updated' })).resolves.toEqual({
      ok: false,
      error: 'update failed'
    })
    await expect(addIssueComment('ISS-1', 'Body')).resolves.toEqual({
      ok: false,
      error: 'comment failed'
    })
    await expect(getIssueComments('ISS-1')).resolves.toEqual([])
    await expect(listTeams()).resolves.toEqual([])
  })
})
