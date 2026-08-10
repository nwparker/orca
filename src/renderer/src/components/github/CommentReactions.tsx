import React, { useEffect, useRef, useState } from 'react'
import { Loader2, SmilePlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { GitHubReaction, GitHubReactionContent } from '../../../../shared/types'

const REACTION_CONTENTS: GitHubReactionContent[] = [
  '+1',
  '-1',
  'laugh',
  'confused',
  'heart',
  'hooray',
  'rocket',
  'eyes'
]

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

function getReactionName(content: GitHubReactionContent): string {
  switch (content) {
    case '+1':
      return translate('auto.components.github.CommentReactions.thumbsUp', 'thumbs up')
    case '-1':
      return translate('auto.components.github.CommentReactions.thumbsDown', 'thumbs down')
    case 'laugh':
      return translate('auto.components.github.CommentReactions.laugh', 'laugh')
    case 'confused':
      return translate('auto.components.github.CommentReactions.confused', 'confused')
    case 'heart':
      return translate('auto.components.github.CommentReactions.heart', 'heart')
    case 'hooray':
      return translate('auto.components.github.CommentReactions.hooray', 'hooray')
    case 'rocket':
      return translate('auto.components.github.CommentReactions.rocket', 'rocket')
    case 'eyes':
      return translate('auto.components.github.CommentReactions.eyes', 'eyes')
  }
}

function getReactionToggleLabel(
  content: GitHubReactionContent,
  add: boolean,
  count?: number
): string {
  if (count !== undefined) {
    return translate(
      add
        ? 'auto.components.github.CommentReactions.addNamedReactionWithCount'
        : 'auto.components.github.CommentReactions.removeNamedReactionWithCount',
      add
        ? 'Add {{value0}} reaction, {{value1}} total'
        : 'Remove {{value0}} reaction, {{value1}} total',
      { value0: getReactionName(content), value1: count }
    )
  }
  return translate(
    add
      ? 'auto.components.github.CommentReactions.addNamedReaction'
      : 'auto.components.github.CommentReactions.removeNamedReaction',
    add ? 'Add {{value0}} reaction' : 'Remove {{value0}} reaction',
    { value0: getReactionName(content) }
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
  const pickerGroupRef = useRef<HTMLDivElement>(null)
  const mutationPendingRef = useRef(false)
  const [pendingContent, setPendingContent] = useState<GitHubReactionContent | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
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

  const toggleReaction = (
    content: GitHubReactionContent,
    add: boolean,
    closePicker: boolean
  ): void => {
    if (!onToggle || mutationPendingRef.current) {
      return
    }
    mutationPendingRef.current = true
    setPendingContent(content)
    void onToggle(content, add)
      .then((changed) => {
        if (changed && closePicker) {
          setPickerOpen(false)
        }
      })
      .catch(() => false)
      .finally(() => {
        mutationPendingRef.current = false
        setPendingContent(null)
      })
  }

  return (
    <div className={cn('mt-2 flex flex-wrap gap-1.5', className)}>
      {visibleReactions.map((reaction) => {
        const content = reaction.content
        const add = !reaction?.viewerHasReacted
        if (!onToggle) {
          return (
            <span
              key={content}
              className="inline-flex h-6 items-center gap-1 rounded-full border border-border/60 bg-muted/35 px-2 text-[12px] leading-none text-foreground"
              aria-label={translate(
                'auto.components.GitHubItemDialog.a18f669c7a',
                '{{value0}} {{value1}} reaction{{value2}}',
                {
                  value0: reaction.count,
                  value1: content,
                  value2: reaction.count === 1 ? '' : 's'
                }
              )}
            >
              <span aria-hidden="true">{REACTION_EMOJI[content]}</span>
              <span className="tabular-nums">{reaction.count}</span>
            </span>
          )
        }
        const label = getReactionToggleLabel(content, add)
        const accessibleLabel = getReactionToggleLabel(content, add, reaction.count)
        return (
          <Tooltip key={content}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="xs"
                className={cn(
                  'min-w-8 rounded-full border-border/60 bg-muted/35 leading-none shadow-none aria-disabled:cursor-wait aria-disabled:opacity-60',
                  reaction?.viewerHasReacted && 'border-ring/50 bg-accent text-accent-foreground'
                )}
                aria-label={accessibleLabel}
                aria-pressed={reaction.viewerHasReacted ?? false}
                aria-disabled={pendingContent !== null}
                onClick={(event) => {
                  event.stopPropagation()
                  toggleReaction(content, add, false)
                }}
              >
                {pendingContent === content && showPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <span aria-hidden="true">{REACTION_EMOJI[content]}</span>
                )}
                <span className="tabular-nums">{reaction.count}</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>{label}</TooltipContent>
          </Tooltip>
        )
      })}
      {onToggle ? (
        <Popover
          open={pickerOpen}
          onOpenChange={(open) => {
            if (!open || !mutationPendingRef.current) {
              setPickerOpen(open)
            }
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon-xs"
                  className="rounded-full border-border/60 bg-muted/35 text-muted-foreground shadow-none aria-disabled:cursor-wait aria-disabled:opacity-60"
                  aria-label={translate(
                    'auto.components.github.CommentReactions.addReaction',
                    'Add reaction'
                  )}
                  aria-disabled={pendingContent !== null}
                  onClick={(event) => {
                    event.stopPropagation()
                    if (mutationPendingRef.current) {
                      event.preventDefault()
                    }
                  }}
                >
                  <SmilePlus />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>
              {translate('auto.components.github.CommentReactions.addReaction', 'Add reaction')}
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            side="top"
            align="start"
            className="w-auto p-1.5"
            onOpenAutoFocus={(event) => {
              event.preventDefault()
              pickerGroupRef.current?.focus()
            }}
          >
            <div
              ref={pickerGroupRef}
              role="group"
              tabIndex={-1}
              aria-label={translate(
                'auto.components.github.CommentReactions.reactions',
                'Reactions'
              )}
              className="grid grid-cols-4 gap-1"
            >
              {REACTION_CONTENTS.map((content) => {
                const reaction = visibleReactions.find((entry) => entry.content === content)
                const add = !reaction?.viewerHasReacted
                const label = getReactionToggleLabel(content, add)
                return (
                  <Tooltip key={content}>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className={cn(
                          'text-lg aria-disabled:cursor-wait aria-disabled:opacity-60',
                          reaction?.viewerHasReacted && 'bg-accent text-accent-foreground'
                        )}
                        aria-label={label}
                        aria-pressed={reaction?.viewerHasReacted ?? false}
                        aria-disabled={pendingContent !== null}
                        onClick={() => toggleReaction(content, add, true)}
                      >
                        {pendingContent === content && showPending ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <span aria-hidden="true">{REACTION_EMOJI[content]}</span>
                        )}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                )
              })}
            </div>
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  )
}
