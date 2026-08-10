import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { GitHubReaction, GitHubReactionContent } from '../../../../shared/types'

const REACTION_EMOJI: Record<GitHubReaction['content'], string> = {
  '+1': '👍',
  '-1': '👎',
  laugh: '😄',
  confused: '😕',
  heart: '❤️',
  hooray: '🎉',
  rocket: '🚀',
  eyes: '👀'
}

function getReactionToggleLabel(content: '+1' | '-1', add: boolean): string {
  if (content === '+1') {
    return add
      ? translate('auto.components.github.CommentReactions.addThumbsUp', 'Add thumbs up reaction')
      : translate(
          'auto.components.github.CommentReactions.removeThumbsUp',
          'Remove thumbs up reaction'
        )
  }
  return add
    ? translate('auto.components.github.CommentReactions.addThumbsDown', 'Add thumbs down reaction')
    : translate(
        'auto.components.github.CommentReactions.removeThumbsDown',
        'Remove thumbs down reaction'
      )
}

export function CommentReactions({
  reactions,
  className,
  onToggle
}: {
  reactions?: GitHubReaction[]
  className?: string
  onToggle?: (content: GitHubReactionContent, add: boolean) => Promise<boolean>
}): React.JSX.Element | null {
  const visibleReactions = (reactions ?? []).filter((reaction) => reaction.count > 0)
  const [pendingContent, setPendingContent] = useState<GitHubReactionContent | null>(null)
  const [showPending, setShowPending] = useState(false)

  useEffect(() => {
    if (!pendingContent) {
      setShowPending(false)
      return
    }
    const timer = window.setTimeout(() => setShowPending(true), 200)
    return () => window.clearTimeout(timer)
  }, [pendingContent])

  if (visibleReactions.length === 0 && !onToggle) {
    return null
  }

  const contents = Array.from(
    new Set<GitHubReactionContent>([
      ...(onToggle ? (['+1', '-1'] as const) : []),
      ...visibleReactions.map((reaction) => reaction.content)
    ])
  )

  return (
    <div className={cn('mt-2 flex flex-wrap gap-1.5', className)}>
      {contents.map((content) => {
        const reaction = visibleReactions.find((entry) => entry.content === content)
        const interactive = onToggle && (content === '+1' || content === '-1')
        const add = !reaction?.viewerHasReacted
        if (!interactive) {
          return (
            <span
              key={content}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/35 px-2 text-[12px] leading-none text-foreground"
              aria-label={translate(
                'auto.components.GitHubItemDialog.a18f669c7a',
                '{{value0}} {{value1}} reaction{{value2}}',
                {
                  value0: reaction?.count ?? 0,
                  value1: content,
                  value2: reaction?.count === 1 ? '' : 's'
                }
              )}
            >
              <span aria-hidden="true">{REACTION_EMOJI[content]}</span>
              <span className="tabular-nums">{reaction?.count}</span>
            </span>
          )
        }
        const label = getReactionToggleLabel(content, add)
        const toggleReaction = onToggle
        return (
          <Tooltip key={content}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className={cn(
                  'min-w-8 rounded-full border-border/60 bg-muted/35 leading-none shadow-none disabled:cursor-wait disabled:opacity-60',
                  reaction?.viewerHasReacted && 'border-ring/50 bg-accent text-accent-foreground'
                )}
                aria-label={label}
                aria-pressed={reaction?.viewerHasReacted ?? false}
                disabled={pendingContent !== null}
                onClick={(event) => {
                  event.stopPropagation()
                  setPendingContent(content)
                  void toggleReaction(content, add)
                    .catch(() => false)
                    .finally(() => setPendingContent(null))
                }}
              >
                {pendingContent === content && showPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <span aria-hidden="true">{REACTION_EMOJI[content]}</span>
                )}
                {(reaction?.count ?? 0) > 0 ? (
                  <span className="tabular-nums">{reaction?.count}</span>
                ) : null}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
