import type { GitHubReaction, GitHubReactionContent } from '../../shared/types'

type GitHubGraphQLReactionContent =
  | 'THUMBS_UP'
  | 'THUMBS_DOWN'
  | 'LAUGH'
  | 'CONFUSED'
  | 'HEART'
  | 'HOORAY'
  | 'ROCKET'
  | 'EYES'

export type GitHubGraphQLReactionGroup = {
  content?: string | null
  reactors?: { totalCount?: number | null } | null
  viewerHasReacted?: boolean | null
}

const GRAPHQL_REACTION_CONTENT: Record<GitHubGraphQLReactionContent, GitHubReactionContent> = {
  THUMBS_UP: '+1',
  THUMBS_DOWN: '-1',
  LAUGH: 'laugh',
  CONFUSED: 'confused',
  HEART: 'heart',
  HOORAY: 'hooray',
  ROCKET: 'rocket',
  EYES: 'eyes'
}

const GITHUB_REACTION_CONTENT = Object.fromEntries(
  Object.entries(GRAPHQL_REACTION_CONTENT).map(([graphqlContent, content]) => [
    content,
    graphqlContent
  ])
) as Record<GitHubReactionContent, GitHubGraphQLReactionContent>

export function getGraphQLReactionContent(
  content: GitHubReactionContent
): GitHubGraphQLReactionContent {
  return GITHUB_REACTION_CONTENT[content]
}

const REACTION_ORDER: GitHubReactionContent[] = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes'
]

export function mapGraphQLReactionGroups(
  groups?: GitHubGraphQLReactionGroup[] | null
): GitHubReaction[] | undefined {
  const reactionsByContent = new Map<GitHubReactionContent, GitHubReaction>()
  for (const group of groups ?? []) {
    const content =
      group.content && group.content in GRAPHQL_REACTION_CONTENT
        ? GRAPHQL_REACTION_CONTENT[group.content as GitHubGraphQLReactionContent]
        : null
    const count = group.reactors?.totalCount ?? 0
    if (!content || count <= 0) {
      continue
    }
    const current = reactionsByContent.get(content)
    reactionsByContent.set(content, {
      content,
      count: (current?.count ?? 0) + count,
      viewerHasReacted: Boolean(current?.viewerHasReacted || group.viewerHasReacted)
    })
  }

  const reactions = REACTION_ORDER.flatMap((content) => {
    const reaction = reactionsByContent.get(content)
    return reaction ? [reaction] : []
  })
  return reactions.length > 0 ? reactions : undefined
}
