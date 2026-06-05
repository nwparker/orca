import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { MemorySnapshot } from '../../../../shared/types'
import type { UnifiedProjectGroup } from './mergeSnapshotAndSessions'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { buildResourceMemoryDiagnostics } from './resource-memory-diagnostics'

function getPlatformLabel(): string {
  if (navigator.userAgent.includes('Windows')) {
    return 'Windows'
  }
  if (navigator.userAgent.includes('Linux')) {
    return 'Linux'
  }
  return 'macOS'
}

export function ResourceMemoryDiagnosticsCopyButton({
  snapshot,
  repos
}: {
  snapshot: MemorySnapshot
  repos: UnifiedProjectGroup[]
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const mountedRef = useRef(false)
  const copiedResetTimerRef = useRef<number | null>(null)

  const clearCopiedResetTimer = useCallback((): void => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current)
      copiedResetTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearCopiedResetTimer()
    }
  }, [clearCopiedResetTimer])

  const copyDiagnostics = useCallback((): void => {
    const text = buildResourceMemoryDiagnostics({
      snapshot,
      repos,
      platformLabel: getPlatformLabel()
    })
    void window.api.ui
      .writeClipboardText(text)
      .then(() => {
        if (!mountedRef.current) {
          return
        }
        clearCopiedResetTimer()
        setCopied(true)
        copiedResetTimerRef.current = window.setTimeout(() => {
          copiedResetTimerRef.current = null
          setCopied(false)
        }, 1500)
      })
      .catch(() => {
        /* best-effort diagnostics copy */
      })
  }, [clearCopiedResetTimer, repos, snapshot])

  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={copyDiagnostics}
          aria-label="Copy memory diagnostics"
          className="inline-flex size-6 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {copied ? 'Copied diagnostics' : 'Copy diagnostics'}
      </TooltipContent>
    </Tooltip>
  )
}
