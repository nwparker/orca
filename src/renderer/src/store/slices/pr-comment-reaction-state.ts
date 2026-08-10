import type { GitHubReaction, GitHubReactionContent, PRComment } from '../../../../shared/types'

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

function updateReactions(
  reactions: GitHubReaction[] | undefined,
  content: GitHubReactionContent,
  add: boolean
): GitHubReaction[] | undefined {
  const current = reactions?.find((reaction) => reaction.content === content)
  const nextCount = Math.max(0, (current?.count ?? 0) + (add ? 1 : -1))
  const next = (reactions ?? []).filter((reaction) => reaction.content !== content)
  if (nextCount > 0) {
    next.push({ content, count: nextCount, viewerHasReacted: add })
  }
  next.sort(
    (left, right) => REACTION_ORDER.indexOf(left.content) - REACTION_ORDER.indexOf(right.content)
  )
  return next.length > 0 ? next : undefined
}

export function updatePRCommentReaction(
  comments: PRComment[],
  identity: Pick<PRComment, 'id' | 'nodeId'>,
  content: GitHubReactionContent,
  add: boolean
): PRComment[] {
  return comments.map((comment) => {
    const matches = identity.nodeId
      ? comment.nodeId === identity.nodeId
      : comment.id === identity.id
    return matches
      ? { ...comment, reactions: updateReactions(comment.reactions, content, add) }
      : comment
  })
}
