/* eslint-disable max-lines -- Why: project-view parser coverage uses one
   GitHub CLI mock harness across URL, GraphQL, and fallback cases. */
// Why: covers the recent fixes —
// (a) network errors must NOT be misclassified as not_found ("could not
//     resolve host" partially overlaps "could not resolve to a"),
// (b) repo slug validation must accept names with leading underscore
//     (GitHub allows them, e.g. `_internal`),
// (c) owner slug validation must reject `.`/`_` (GitHub disallows them in
//     usernames/orgs),
// (d) parseProjectPaste shorthand owner-only alphabet matches the renderer.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, acquireMock, releaseMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('../git/runner', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  extractExecError: (err: unknown) => ({
    stderr:
      err && typeof err === 'object' && 'stderr' in err
        ? String((err as { stderr: string }).stderr)
        : '',
    stdout:
      err && typeof err === 'object' && 'stdout' in err
        ? String((err as { stdout: string }).stdout)
        : ''
  })
}))

import {
  _resetProjectViewModuleState,
  addIssueCommentBySlug,
  clearProjectItemFieldValue,
  classifyProjectError,
  deleteIssueCommentBySlug,
  getProjectViewTable,
  getWorkItemDetailsBySlug,
  isValidOwnerSlug,
  isValidRepoSlug,
  listAccessibleProjects,
  listAssignableUsersBySlug,
  listIssueTypesBySlug,
  listLabelsBySlug,
  listProjectViews,
  normalizeField,
  normalizeFieldValue,
  normalizeItem,
  parseProjectPaste,
  resolveProjectRef,
  updateIssueBySlug,
  updateIssueCommentBySlug,
  updateIssueTypeBySlug,
  updateProjectItemFieldValue,
  updatePullRequestBySlug
} from './project-view'

function graphqlResponse(data: unknown): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify({ data }), stderr: '' }
}

function graphqlErrorResponse(errors: unknown[]): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify({ errors }), stderr: 'GraphQL: error' }
}

function projectConfigResponse(view: Record<string, unknown>, options?: { hasNextPage?: boolean }) {
  return graphqlResponse({
    organization: {
      projectV2: {
        id: 'PVT_project',
        title: 'Roadmap',
        url: 'https://github.com/orgs/acme/projects/7',
        views: {
          pageInfo: {
            hasNextPage: options?.hasNextPage ?? false,
            endCursor: options?.hasNextPage ? 'next-view-page' : null
          },
          nodes: [view]
        }
      }
    }
  })
}

function tableView(overrides: Record<string, unknown> = {}) {
  return {
    id: 'PVTV_table',
    number: 3,
    name: 'Table',
    layout: 'TABLE_LAYOUT',
    filter: 'is:open',
    fields: {
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [
        { __typename: 'ProjectV2Field', id: 'field_title', name: 'Title', dataType: 'TITLE' },
        {
          __typename: 'ProjectV2SingleSelectField',
          id: 'field_status',
          name: 'Status',
          dataType: 'SINGLE_SELECT',
          options: [{ id: 'opt_todo', name: 'Todo', color: 'GRAY' }]
        }
      ]
    },
    groupByFields: { nodes: [{ id: 'field_status', name: 'Status', dataType: 'SINGLE_SELECT' }] },
    sortByFields: {
      nodes: [{ direction: 'ASC', field: { id: 'field_title', name: 'Title', dataType: 'TITLE' } }]
    },
    ...overrides
  }
}

function itemsResponse(options?: {
  totalCount?: number
  hasNextPage?: boolean
  endCursor?: string | null
  nodes?: unknown[]
}) {
  return graphqlResponse({
    organization: {
      projectV2: {
        items: {
          totalCount: options?.totalCount ?? options?.nodes?.length ?? 1,
          pageInfo: {
            hasNextPage: options?.hasNextPage ?? false,
            endCursor: options?.endCursor ?? null
          },
          nodes: options?.nodes ?? [
            {
              id: 'item_1',
              type: 'ISSUE',
              updatedAt: '2026-01-01T00:00:00Z',
              content: {
                __typename: 'Issue',
                id: 'issue_1',
                number: 12,
                title: 'Fix table',
                url: 'https://github.com/acme/widgets/issues/12',
                state: 'OPEN',
                stateReason: null,
                repository: { nameWithOwner: 'acme/widgets' },
                assignees: { nodes: [{ login: 'octo', name: 'Octo', avatarUrl: 'avatar' }] },
                labels: { nodes: [{ name: 'bug', color: 'red' }] },
                parent: {
                  number: 1,
                  title: 'Parent',
                  url: 'https://github.com/acme/widgets/issues/1'
                },
                issueType: { id: 'it_bug', name: 'Bug', color: 'RED', description: 'Breakage' }
              },
              fieldValues: {
                pageInfo: { hasNextPage: false },
                nodes: [
                  {
                    __typename: 'ProjectV2ItemFieldSingleSelectValue',
                    field: { id: 'field_status', name: 'Status', dataType: 'SINGLE_SELECT' },
                    optionId: 'opt_todo',
                    name: 'Todo',
                    color: 'GRAY'
                  }
                ]
              }
            }
          ]
        }
      }
    }
  })
}

beforeEach(() => {
  ghExecFileAsyncMock.mockReset()
  acquireMock.mockReset()
  releaseMock.mockReset()
  acquireMock.mockResolvedValue(undefined)
  _resetProjectViewModuleState()
})

describe('classifyProjectError', () => {
  it('classifies HTTP 404 as not_found', () => {
    expect(classifyProjectError('HTTP 404 Not Found', '').type).toBe('not_found')
  })

  it('classifies "Could not resolve to a User" as not_found', () => {
    expect(classifyProjectError('Could not resolve to a User with the login of foo', '').type).toBe(
      'not_found'
    )
  })

  it('classifies "could not resolve host" as network_error, NOT not_found', () => {
    // Why: this was the bug — substring "could not resolve" overlaps. The
    // network branch must run before not_found, and the not_found check
    // must require "to a " to disambiguate.
    expect(classifyProjectError('could not resolve host: api.github.com', '').type).toBe(
      'network_error'
    )
  })

  it('classifies "dial tcp" timeouts as network_error', () => {
    expect(classifyProjectError('dial tcp 140.82.112.3:443: i/o timeout', '').type).toBe(
      'network_error'
    )
  })

  it('classifies rate-limit text as rate_limited', () => {
    expect(classifyProjectError('API rate limit exceeded for user', '').type).toBe('rate_limited')
  })

  it('classifies missing-scope as scope_missing', () => {
    expect(
      classifyProjectError('your token has not been granted the required scopes', '').type
    ).toBe('scope_missing')
  })

  it('classifies auth-required when gh is not signed in', () => {
    expect(classifyProjectError('gh auth login required', '').type).toBe('auth_required')
  })
})

describe('isValidOwnerSlug', () => {
  it('accepts plain alphanumerics and hyphens', () => {
    expect(isValidOwnerSlug('acme')).toBe(true)
    expect(isValidOwnerSlug('acme-co')).toBe(true)
    expect(isValidOwnerSlug('user1')).toBe(true)
  })

  it('rejects underscore (GitHub disallows it in usernames/orgs)', () => {
    expect(isValidOwnerSlug('_acme')).toBe(false)
    expect(isValidOwnerSlug('acme_co')).toBe(false)
  })

  it('rejects leading hyphen and dot', () => {
    expect(isValidOwnerSlug('-acme')).toBe(false)
    expect(isValidOwnerSlug('.acme')).toBe(false)
  })

  it('rejects empty and slash-containing values', () => {
    expect(isValidOwnerSlug('')).toBe(false)
    expect(isValidOwnerSlug('a/b')).toBe(false)
    expect(isValidOwnerSlug(123)).toBe(false)
  })
})

describe('isValidRepoSlug', () => {
  it('accepts leading underscore (GitHub allows it for repo names)', () => {
    expect(isValidRepoSlug('_internal')).toBe(true)
  })

  it('accepts leading dot', () => {
    expect(isValidRepoSlug('.github')).toBe(true)
  })

  it('accepts dots, dashes, underscores anywhere', () => {
    expect(isValidRepoSlug('repo-name')).toBe(true)
    expect(isValidRepoSlug('repo.name')).toBe(true)
    expect(isValidRepoSlug('repo_name')).toBe(true)
  })

  it('rejects reserved single/double dot', () => {
    expect(isValidRepoSlug('.')).toBe(false)
    expect(isValidRepoSlug('..')).toBe(false)
  })

  it('rejects path separators and empty', () => {
    expect(isValidRepoSlug('a/b')).toBe(false)
    expect(isValidRepoSlug('')).toBe(false)
  })
})

describe('parseProjectPaste', () => {
  it('parses owner/number shorthand', () => {
    expect(parseProjectPaste('acme/42')).toEqual({ kind: 'bare', owner: 'acme', number: 42 })
  })

  it('rejects shorthand with underscore in owner (renderer parity)', () => {
    // Why: the renderer's parser uses `[A-Za-z0-9][A-Za-z0-9-]*` for owner
    // (matches OWNER_SLUG_RE). Both sides must reject the same inputs.
    expect(parseProjectPaste('co_op/45')).toBeNull()
  })

  it('parses org URL with view number', () => {
    expect(parseProjectPaste('https://github.com/orgs/acme/projects/42/views/3')).toEqual({
      kind: 'org',
      owner: 'acme',
      number: 42,
      viewNumber: 3
    })
  })

  it('parses user URL', () => {
    expect(parseProjectPaste('https://github.com/users/octocat/projects/1')).toEqual({
      kind: 'user',
      owner: 'octocat',
      number: 1
    })
  })

  it('rejects URLs whose owner has invalid characters', () => {
    expect(parseProjectPaste('https://github.com/orgs/co_op/projects/1')).toBeNull()
  })

  it('returns null for empty input', () => {
    expect(parseProjectPaste('')).toBeNull()
    expect(parseProjectPaste('   ')).toBeNull()
  })
})

describe('ProjectV2 normalizers', () => {
  it('normalizes supported field shapes and filters malformed options', () => {
    expect(
      normalizeField({
        __typename: 'ProjectV2SingleSelectField',
        id: 'status',
        name: 'Status',
        options: [{ id: 'todo', name: 'Todo', color: 'GRAY' }, { id: 'bad' }]
      })
    ).toEqual({
      kind: 'single-select',
      id: 'status',
      name: 'Status',
      dataType: 'SINGLE_SELECT',
      options: [{ id: 'todo', name: 'Todo', color: 'GRAY' }]
    })

    expect(
      normalizeField({
        __typename: 'ProjectV2IterationField',
        id: 'sprint',
        name: 'Sprint',
        configuration: {
          completedIterations: [{ id: 'old', title: 'Old', startDate: '2026-01-01', duration: 14 }],
          iterations: [{ id: 'now', title: 'Now', startDate: '2026-01-15', duration: 14 }]
        }
      })
    ).toEqual({
      kind: 'iteration',
      id: 'sprint',
      name: 'Sprint',
      dataType: 'ITERATION',
      iterations: [
        { id: 'old', title: 'Old', startDate: '2026-01-01', duration: 14, completed: true },
        { id: 'now', title: 'Now', startDate: '2026-01-15', duration: 14, completed: false }
      ]
    })

    expect(normalizeField({ id: 'plain', name: 'Plain', dataType: 'TEXT' })).toEqual({
      kind: 'field',
      id: 'plain',
      name: 'Plain',
      dataType: 'TEXT'
    })
    expect(normalizeField({ id: 'missing-name' })).toBeNull()
  })

  it('normalizes project item field values by typename', () => {
    const field = { id: 'f1', name: 'Field', dataType: 'TEXT' }
    expect(
      normalizeFieldValue({
        __typename: 'ProjectV2ItemFieldSingleSelectValue',
        field,
        optionId: 'opt',
        name: 'Ready',
        color: 'GREEN'
      })
    ).toEqual({
      kind: 'single-select',
      fieldId: 'f1',
      optionId: 'opt',
      name: 'Ready',
      color: 'GREEN'
    })
    expect(
      normalizeFieldValue({
        __typename: 'ProjectV2ItemFieldIterationValue',
        field,
        iterationId: 'it',
        title: 'Sprint',
        startDate: '2026-02-01',
        duration: 7
      })
    ).toEqual({
      kind: 'iteration',
      fieldId: 'f1',
      iterationId: 'it',
      title: 'Sprint',
      startDate: '2026-02-01',
      duration: 7
    })
    expect(
      normalizeFieldValue({ __typename: 'ProjectV2ItemFieldTextValue', field, text: 'hello' })
    ).toEqual({ kind: 'text', fieldId: 'f1', text: 'hello' })
    expect(
      normalizeFieldValue({ __typename: 'ProjectV2ItemFieldNumberValue', field, number: 4 })
    ).toEqual({ kind: 'number', fieldId: 'f1', number: 4 })
    expect(
      normalizeFieldValue({ __typename: 'ProjectV2ItemFieldDateValue', field, date: '2026-03-01' })
    ).toEqual({ kind: 'date', fieldId: 'f1', date: '2026-03-01' })
    expect(
      normalizeFieldValue({
        __typename: 'ProjectV2ItemFieldLabelValue',
        field,
        labels: { nodes: [{ name: 'bug', color: 'red' }, { color: 'missing-name' }] }
      })
    ).toEqual({ kind: 'labels', fieldId: 'f1', labels: [{ name: 'bug', color: 'red' }] })
    expect(
      normalizeFieldValue({
        __typename: 'ProjectV2ItemFieldUserValue',
        field,
        users: { nodes: [{ login: 'octo', name: null, avatarUrl: 'avatar' }, { name: 'No login' }] }
      })
    ).toEqual({
      kind: 'users',
      fieldId: 'f1',
      users: [{ login: 'octo', name: null, avatarUrl: 'avatar' }]
    })
    expect(normalizeFieldValue({ __typename: 'UnknownValue', field })).toBeNull()
  })

  it('normalizes issue, pull request, draft, and redacted items', () => {
    const issue = normalizeItem(
      {
        id: 'item_issue',
        type: 'ISSUE',
        updatedAt: '2026-01-01T00:00:00Z',
        content: {
          title: 'Issue title',
          number: 11,
          url: 'https://github.com/acme/widgets/issues/11',
          state: 'OPEN',
          stateReason: 'REOPENED',
          repository: { nameWithOwner: 'acme/widgets' },
          assignees: { nodes: [{ login: 'mona' }] },
          labels: { nodes: [{ name: 'bug' }] },
          parent: { number: 3, title: 'Parent', url: 'https://github.com/acme/widgets/issues/3' },
          issueType: { id: 'bug', name: 'Bug', color: null, description: 'Broken' }
        },
        fieldValues: {
          pageInfo: { hasNextPage: false },
          nodes: [
            {
              __typename: 'ProjectV2ItemFieldTextValue',
              field: { id: 'field_notes', name: 'Notes', dataType: 'TEXT' },
              text: 'note'
            }
          ]
        }
      },
      2
    )
    expect(issue).toMatchObject({
      ok: true,
      row: {
        id: 'item_issue',
        itemType: 'ISSUE',
        position: 2,
        content: {
          number: 11,
          title: 'Issue title',
          repository: 'acme/widgets',
          parentIssue: { number: 3, title: 'Parent' },
          issueType: { id: 'bug', name: 'Bug' }
        },
        fieldValuesByFieldId: { field_notes: { kind: 'text', text: 'note' } }
      }
    })

    expect(
      normalizeItem(
        {
          id: 'item_pr',
          type: 'PULL_REQUEST',
          content: { title: 'PR', isDraft: true },
          fieldValues: { pageInfo: { hasNextPage: false }, nodes: [] }
        },
        0
      )
    ).toMatchObject({
      ok: true,
      row: { itemType: 'PULL_REQUEST', content: { title: 'PR', isDraft: true } }
    })

    expect(
      normalizeItem(
        {
          id: 'item_draft',
          type: 'DRAFT_ISSUE',
          content: { title: 'Draft', body: 'Body' },
          fieldValues: { pageInfo: { hasNextPage: false }, nodes: [] }
        },
        1
      )
    ).toMatchObject({
      ok: true,
      row: { itemType: 'DRAFT_ISSUE', content: { title: 'Draft', body: 'Body' } }
    })

    expect(
      normalizeItem(
        { id: 'item_redacted', type: 'REDACTED', content: null, fieldValues: { nodes: [] } },
        3
      )
    ).toMatchObject({
      ok: true,
      row: { itemType: 'REDACTED', content: { title: 'Restricted item' } }
    })
  })

  it('reports schema drift for malformed items', () => {
    expect(normalizeItem({ type: 'ISSUE' }, 0)).toMatchObject({
      ok: false,
      drift: { type: 'schema_drift' }
    })
    expect(
      normalizeItem(
        {
          id: 'item',
          type: 'ISSUE',
          fieldValues: { pageInfo: { hasNextPage: true }, nodes: [] }
        },
        1
      )
    ).toMatchObject({ ok: false, drift: { type: 'schema_drift' } })
  })
})

describe('getProjectViewTable', () => {
  it('loads a selected table view and normalizes rows', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(projectConfigResponse(tableView()))
      .mockResolvedValueOnce(itemsResponse())

    const result = await getProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 7,
      viewNumber: 3
    })

    expect(result).toMatchObject({
      ok: true,
      data: {
        project: { owner: 'acme', ownerType: 'organization', number: 7, title: 'Roadmap' },
        selectedView: {
          id: 'PVTV_table',
          number: 3,
          name: 'Table',
          fields: [{ id: 'field_title' }, { id: 'field_status' }],
          groupByFields: [{ id: 'field_status' }],
          sortByFields: [{ direction: 'ASC', field: { id: 'field_title' } }]
        },
        rows: [
          {
            id: 'item_1',
            itemType: 'ISSUE',
            content: {
              title: 'Fix table',
              parentIssue: { number: 1 },
              issueType: { id: 'it_bug' }
            },
            fieldValuesByFieldId: { field_status: { kind: 'single-select', optionId: 'opt_todo' } }
          }
        ],
        totalCount: 1,
        parentFieldDropped: false
      }
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('uses queryOverride and paginates rows', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(projectConfigResponse(tableView()))
      .mockResolvedValueOnce(
        itemsResponse({
          totalCount: 2,
          hasNextPage: true,
          endCursor: 'cursor-1',
          nodes: [
            {
              id: 'item_1',
              type: 'DRAFT_ISSUE',
              content: { title: 'Draft one' },
              fieldValues: { pageInfo: { hasNextPage: false }, nodes: [] }
            }
          ]
        })
      )
      .mockResolvedValueOnce(
        itemsResponse({
          totalCount: 2,
          nodes: [
            {
              id: 'item_2',
              type: 'PULL_REQUEST',
              content: { title: 'PR two', number: 22, isDraft: false },
              fieldValues: { pageInfo: { hasNextPage: false }, nodes: [] }
            }
          ]
        })
      )

    const result = await getProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 7,
      queryOverride: ''
    })

    expect(result).toMatchObject({
      ok: true,
      data: { rows: [{ content: { title: 'Draft one' } }, { content: { title: 'PR two' } }] }
    })
    expect(ghExecFileAsyncMock.mock.calls[1][0]).toContain('-f')
    expect(ghExecFileAsyncMock.mock.calls[1][0]).toContain('q=')
    expect(ghExecFileAsyncMock.mock.calls[2][0]).toContain('after=cursor-1')
  })

  it('paginates view fields before finalizing the selected view', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(
        projectConfigResponse(
          tableView({
            fields: {
              pageInfo: { hasNextPage: true, endCursor: 'field-cursor' },
              nodes: [{ id: 'field_a', name: 'A', dataType: 'TEXT' }]
            }
          })
        )
      )
      .mockResolvedValueOnce(
        graphqlResponse({
          node: {
            id: 'PVTV_table',
            fields: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ id: 'field_b', name: 'B', dataType: 'NUMBER' }]
            }
          }
        })
      )
      .mockResolvedValueOnce(itemsResponse())

    const result = await getProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 7,
      viewNumber: 3
    })

    expect(result).toMatchObject({
      ok: true,
      data: { selectedView: { fields: [{ id: 'field_a' }, { id: 'field_b' }] } }
    })
  })

  it('returns unsupported_layout with a best-effort count', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(projectConfigResponse(tableView({ layout: 'BOARD_LAYOUT' })))
      .mockResolvedValueOnce(
        graphqlResponse({ organization: { projectV2: { items: { totalCount: 12 } } } })
      )

    const result = await getProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 7,
      viewNumber: 3
    })

    expect(result).toMatchObject({
      ok: false,
      error: { type: 'unsupported_layout' },
      totalCount: 12
    })
  })

  it('retries without Issue.parent when GitHub rejects the parent field', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(projectConfigResponse(tableView()))
      .mockResolvedValueOnce(
        graphqlErrorResponse([
          {
            type: 'FIELD_NOT_FOUND',
            path: ['query', 'organization', 'projectV2', 'items', 'nodes', 'content', 'parent']
          }
        ])
      )
      .mockResolvedValueOnce(itemsResponse())

    const result = await getProjectViewTable({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 7
    })

    expect(result).toMatchObject({ ok: true, data: { parentFieldDropped: true } })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
  })

  it('rejects invalid selectors and missing views before fetching items', async () => {
    await expect(
      getProjectViewTable({ owner: 'bad_owner', ownerType: 'organization', projectNumber: 7 })
    ).resolves.toMatchObject({ ok: false, error: { type: 'validation_error' } })

    ghExecFileAsyncMock.mockResolvedValueOnce(
      projectConfigResponse(tableView({ number: 1, name: 'Not it' }))
    )
    await expect(
      getProjectViewTable({
        owner: 'acme',
        ownerType: 'organization',
        projectNumber: 7,
        viewName: 'Missing'
      })
    ).resolves.toMatchObject({ ok: false, error: { type: 'not_found' } })
  })
})

describe('ProjectV2 discovery and resolution', () => {
  it('discovers viewer and organization projects with partial org-list failures', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(
        graphqlResponse({
          viewer: {
            login: 'octocat',
            projectsV2: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'viewer_project',
                  number: 1,
                  title: 'Mine',
                  url: 'https://github.com/users/octocat/projects/1',
                  owner: { __typename: 'User', login: 'octocat' }
                }
              ]
            }
          }
        })
      )
      .mockRejectedValueOnce({ stderr: 'HTTP 504 Gateway Timeout', stdout: '' })

    const result = await listAccessibleProjects()

    expect(result).toMatchObject({
      ok: true,
      projects: [
        {
          id: 'viewer_project',
          owner: 'octocat',
          ownerType: 'user',
          number: 1,
          title: 'Mine',
          source: 'viewer'
        }
      ],
      partialFailures: [{ owner: '*', message: 'Network error — check your connection.' }]
    })
  })

  it('resolves project URLs and carries a view number', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(graphqlResponse({ organization: { login: 'acme' } }))
      .mockResolvedValueOnce(
        graphqlResponse({ organization: { projectV2: { id: 'PVT_project', title: 'Roadmap' } } })
      )

    const result = await resolveProjectRef({
      input: 'https://github.com/orgs/acme/projects/7/views/3'
    })

    expect(result).toEqual({
      ok: true,
      owner: 'acme',
      ownerType: 'organization',
      number: 7,
      title: 'Roadmap',
      viewNumber: 3
    })
  })

  it('falls back from organization to user for owner/number shorthand', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(graphqlResponse({ organization: null }))
      .mockResolvedValueOnce(graphqlResponse({ user: { login: 'octocat' } }))
      .mockResolvedValueOnce(
        graphqlResponse({ user: { projectV2: { id: 'PVT_project', title: 'User board' } } })
      )

    const result = await resolveProjectRef({ input: 'octocat/2' })

    expect(result).toMatchObject({
      ok: true,
      owner: 'octocat',
      ownerType: 'user',
      number: 2,
      title: 'User board'
    })
  })

  it('lists project views across pages and skips malformed views', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(
        projectConfigResponse(tableView({ id: 'first', number: 1 }), { hasNextPage: true })
      )
      .mockResolvedValueOnce(
        graphqlResponse({
          organization: {
            projectV2: {
              id: 'PVT_project',
              title: 'Roadmap',
              url: 'https://github.com/orgs/acme/projects/7',
              views: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { id: 'second', number: 2, name: 'Board', layout: 'BOARD_LAYOUT' },
                  { number: 3, name: 'Malformed', layout: 'TABLE_LAYOUT' }
                ]
              }
            }
          }
        })
      )

    const result = await listProjectViews({
      owner: 'acme',
      ownerType: 'organization',
      projectNumber: 7
    })

    expect(result).toEqual({
      ok: true,
      views: [
        { id: 'first', number: 1, name: 'Table', layout: 'TABLE_LAYOUT' },
        { id: 'second', number: 2, name: 'Board', layout: 'BOARD_LAYOUT' }
      ]
    })
  })
})

describe('ProjectV2 slug-addressed mutations', () => {
  it('updates and clears project item field values through GraphQL', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(
        graphqlResponse({ updateProjectV2ItemFieldValue: { projectV2Item: { id: 'item' } } })
      )
      .mockResolvedValueOnce(
        graphqlResponse({ clearProjectV2ItemFieldValue: { projectV2Item: { id: 'item' } } })
      )

    await expect(
      updateProjectItemFieldValue({
        projectId: 'project',
        itemId: 'item',
        fieldId: 'field',
        value: { kind: 'single-select', optionId: 'option' }
      })
    ).resolves.toEqual({ ok: true })
    await expect(
      clearProjectItemFieldValue({ projectId: 'project', itemId: 'item', fieldId: 'field' })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock.mock.calls[0][0]).toContain('value=option')
    expect(ghExecFileAsyncMock.mock.calls[1][0].join(' ')).toContain('clearProjectV2ItemFieldValue')
  })

  it('validates project field mutation inputs before dispatching', async () => {
    await expect(
      updateProjectItemFieldValue({
        projectId: '',
        itemId: 'item',
        fieldId: 'field',
        value: { kind: 'text', text: 'Nope' }
      })
    ).resolves.toMatchObject({ ok: false, error: { type: 'validation_error' } })
    await expect(
      updateProjectItemFieldValue({
        projectId: 'project',
        itemId: 'item',
        fieldId: 'field',
        value: { kind: 'mystery' } as never
      })
    ).resolves.toMatchObject({
      ok: false,
      error: { type: 'validation_error', message: 'Unknown project field mutation kind: mystery' }
    })
  })

  it('updates issues with collapsed label and assignee operations', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '{}', stderr: '' })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ name: 'bug' }, { name: 'old' }]),
        stderr: ''
      })
      .mockResolvedValueOnce({ stdout: '{}', stderr: '' })
      .mockResolvedValueOnce({ stdout: '{}', stderr: '' })
      .mockResolvedValueOnce({ stdout: '{}', stderr: '' })

    const result = await updateIssueBySlug({
      owner: 'acme',
      repo: 'widgets',
      number: 42,
      updates: {
        title: 'New title',
        body: 'New body',
        state: 'closed',
        addLabels: ['new'],
        removeLabels: ['old', 'stale'],
        addAssignees: ['mona'],
        removeAssignees: ['octo']
      }
    })

    expect(result).toEqual({ ok: true })
    expect(ghExecFileAsyncMock.mock.calls.map((call) => call[0].join(' '))).toEqual([
      expect.stringContaining('PATCH repos/acme/widgets/issues/42'),
      expect.stringContaining('GET repos/acme/widgets/issues/42/labels'),
      expect.stringContaining('PUT repos/acme/widgets/issues/42/labels'),
      expect.stringContaining('POST repos/acme/widgets/issues/42/assignees'),
      expect.stringContaining('DELETE repos/acme/widgets/issues/42/assignees')
    ])
  })

  it('clears all labels with the dedicated delete endpoint', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ name: 'bug' }, { name: 'old' }]),
        stderr: ''
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(
      updateIssueBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 42,
        updates: { removeLabels: ['bug', 'old'] }
      })
    ).resolves.toEqual({ ok: true })
    expect(ghExecFileAsyncMock.mock.calls[1][0].join(' ')).toContain(
      'DELETE repos/acme/widgets/issues/42/labels'
    )
  })

  it('updates pull requests only when fields are present', async () => {
    await expect(
      updatePullRequestBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 9,
        updates: {}
      })
    ).resolves.toEqual({ ok: true })
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()

    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '{}', stderr: '' })
    await expect(
      updatePullRequestBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 9,
        updates: { title: 'PR title', body: 'PR body' }
      })
    ).resolves.toEqual({ ok: true })
    expect(ghExecFileAsyncMock.mock.calls[0][0].join(' ')).toContain(
      'PATCH repos/acme/widgets/pulls/9'
    )
  })

  it('adds, edits, and deletes issue comments', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          id: 123,
          user: { login: 'mona', avatar_url: 'avatar', type: 'Bot' },
          body: 'Created',
          created_at: '2026-01-01T00:00:00Z',
          html_url: 'https://github.com/acme/widgets/issues/1#issuecomment-123'
        }),
        stderr: ''
      })
      .mockResolvedValueOnce({ stdout: '{}', stderr: '' })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(
      addIssueCommentBySlug({ owner: 'acme', repo: 'widgets', number: 1, body: 'Created' })
    ).resolves.toMatchObject({
      ok: true,
      comment: { id: 123, author: 'mona', body: 'Created', isBot: true }
    })
    await expect(
      updateIssueCommentBySlug({
        owner: 'acme',
        repo: 'widgets',
        commentId: 123,
        body: 'Edited'
      })
    ).resolves.toEqual({ ok: true })
    await expect(
      deleteIssueCommentBySlug({ owner: 'acme', repo: 'widgets', commentId: 123 })
    ).resolves.toEqual({ ok: true })
  })

  it('lists labels and assignable users from paginated REST output', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'bug\nenhancement\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout:
          '{"login":"mona","name":null,"avatarUrl":"avatar"}\nnot-json\n{"login":"octo","avatarUrl":"octo.png"}\n',
        stderr: ''
      })

    await expect(listLabelsBySlug({ owner: 'acme', repo: 'widgets' })).resolves.toEqual({
      ok: true,
      labels: ['bug', 'enhancement']
    })
    await expect(
      listAssignableUsersBySlug({
        owner: 'acme',
        repo: 'widgets',
        seedLogins: ['mona', 'hubot']
      })
    ).resolves.toEqual({
      ok: true,
      users: [
        { login: 'mona', name: null, avatarUrl: 'avatar' },
        { login: 'octo', name: null, avatarUrl: 'octo.png' },
        { login: 'hubot', name: null, avatarUrl: '' }
      ]
    })
  })

  it('lists issue types and maps unsupported schemas to an empty list', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(
        graphqlResponse({
          repository: {
            issueTypes: {
              nodes: [
                { id: 'bug', name: 'Bug', color: 'RED', description: 'Breakage' },
                null,
                { id: 'bad' }
              ]
            }
          }
        })
      )
      .mockResolvedValueOnce({
        ...graphqlErrorResponse([
          { message: 'Field issueTypes does not exist on type Repository' }
        ]),
        stderr: 'Validation failed: Field issueTypes does not exist on type Repository'
      })

    await expect(listIssueTypesBySlug({ owner: 'acme', repo: 'widgets' })).resolves.toEqual({
      ok: true,
      types: [{ id: 'bug', name: 'Bug', color: 'RED', description: 'Breakage' }]
    })
    await expect(listIssueTypesBySlug({ owner: 'acme', repo: 'widgets' })).resolves.toEqual({
      ok: true,
      types: []
    })
  })

  it('updates and clears issue types through the dedicated mutation', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(graphqlResponse({ repository: { issue: { id: 'issue_1' } } }))
      .mockResolvedValueOnce(
        graphqlResponse({ updateIssueIssueType: { issue: { id: 'issue_1' } } })
      )
      .mockResolvedValueOnce(graphqlResponse({ repository: { issue: { id: 'issue_1' } } }))
      .mockResolvedValueOnce(
        graphqlResponse({ updateIssueIssueType: { issue: { id: 'issue_1' } } })
      )

    await expect(
      updateIssueTypeBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 1,
        issueTypeId: 'bug'
      })
    ).resolves.toEqual({ ok: true })
    await expect(
      updateIssueTypeBySlug({
        owner: 'acme',
        repo: 'widgets',
        number: 1,
        issueTypeId: null
      })
    ).resolves.toEqual({ ok: true })
    expect(ghExecFileAsyncMock.mock.calls[1][0].join(' ')).toContain('issueTypeId')
    expect(ghExecFileAsyncMock.mock.calls[3][0].join(' ')).toContain('issueTypeId: null')
  })

  it('loads issue and pull request detail payloads by slug', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce(
        graphqlResponse({
          repository: {
            issue: {
              id: 'issue_1',
              number: 1,
              title: 'Issue',
              url: 'https://github.com/acme/widgets/issues/1',
              state: 'OPEN',
              stateReason: null,
              updatedAt: '2026-01-01T00:00:00Z',
              body: 'Issue body',
              author: { login: 'mona' },
              labels: { nodes: [{ name: 'bug' }] },
              assignees: { nodes: [{ login: 'octo' }] },
              participants: { nodes: [{ login: 'mona', name: 'Mona', avatarUrl: 'avatar' }] },
              comments: {
                nodes: [
                  {
                    databaseId: 5,
                    author: { login: 'hubot', avatarUrl: 'bot.png', __typename: 'Bot' },
                    body: 'Comment',
                    createdAt: '2026-01-02T00:00:00Z',
                    url: 'https://github.com/acme/widgets/issues/1#issuecomment-5'
                  }
                ]
              }
            }
          }
        })
      )
      .mockResolvedValueOnce(
        graphqlResponse({
          repository: {
            pullRequest: {
              id: 'pr_2',
              number: 2,
              title: 'PR',
              url: 'https://github.com/acme/widgets/pull/2',
              state: 'OPEN',
              isDraft: true,
              updatedAt: '2026-01-03T00:00:00Z',
              headRefName: 'feature',
              baseRefName: 'main',
              body: 'PR body',
              author: { login: 'octo' },
              labels: { nodes: [] },
              assignees: { nodes: [] },
              participants: { nodes: [] },
              comments: { nodes: [] }
            }
          }
        })
      )

    await expect(
      getWorkItemDetailsBySlug({ owner: 'acme', repo: 'widgets', number: 1, type: 'issue' })
    ).resolves.toMatchObject({
      ok: true,
      details: {
        item: {
          id: 'issue_1',
          type: 'issue',
          title: 'Issue',
          author: 'mona'
        },
        comments: [{ id: 5, author: 'hubot', isBot: true }]
      }
    })
    await expect(
      getWorkItemDetailsBySlug({ owner: 'acme', repo: 'widgets', number: 2, type: 'pr' })
    ).resolves.toMatchObject({
      ok: true,
      details: {
        item: {
          id: 'pr_2',
          type: 'pr',
          title: 'PR',
          state: 'draft',
          branchName: 'feature',
          baseRefName: 'main'
        }
      }
    })
  })
})
