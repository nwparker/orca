import { describe, expect, it } from 'vitest'
import type { PRComment } from '../../../../shared/types'
import { updatePRCommentReaction } from './pr-comment-reaction-state'

const COMMENT: PRComment = {
  id: 7,
  nodeId: 'PRRC_7',
  author: 'coderabbitai',
  authorAvatarUrl: '',
  body: 'Please handle this.',
  createdAt: '2026-08-09T00:00:00.000Z',
  url: ''
}

describe('updatePRCommentReaction', () => {
  it('adds the viewer reaction and count', () => {
    expect(updatePRCommentReaction([COMMENT], COMMENT, '+1', true)[0]?.reactions).toEqual([
      { content: '+1', count: 1, viewerHasReacted: true }
    ])
  })

  it('removes the viewer reaction without dropping other reactions', () => {
    const comment = {
      ...COMMENT,
      reactions: [
        { content: '+1' as const, count: 2, viewerHasReacted: true },
        { content: 'eyes' as const, count: 1, viewerHasReacted: false }
      ]
    }
    expect(updatePRCommentReaction([comment], comment, '+1', false)[0]?.reactions).toEqual([
      { content: '+1', count: 1, viewerHasReacted: false },
      { content: 'eyes', count: 1, viewerHasReacted: false }
    ])
  })

  it('does not update a different comment kind with the same database ID', () => {
    const issueComment = { ...COMMENT, nodeId: 'IC_7' }
    const reviewComment = { ...COMMENT, nodeId: 'PRRC_7' }
    const updated = updatePRCommentReaction(
      [issueComment, reviewComment],
      reviewComment,
      '+1',
      true
    )

    expect(updated[0]?.reactions).toBeUndefined()
    expect(updated[1]?.reactions).toEqual([{ content: '+1', count: 1, viewerHasReacted: true }])
  })
})
