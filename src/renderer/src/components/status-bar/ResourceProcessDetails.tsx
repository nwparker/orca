import React, { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { ProcessMemoryDetail } from '../../../../shared/types'
import {
  formatResourceCpu,
  formatResourceMemory,
  getTopProcesses
} from './resource-memory-diagnostics'

const PROCESS_METRIC_COLUMNS_CLS = 'flex items-center shrink-0 tabular-nums'
const PROCESS_CPU_COLUMN_CLS = 'w-12 text-right'
const PROCESS_MEM_COLUMN_CLS = 'w-16 text-right'
const PROCESS_TRAILING_GUTTER_CLS = 'w-5 shrink-0'

function ProcessMemoryBar({
  memory,
  maxMemory
}: {
  memory: number
  maxMemory: number
}): React.JSX.Element {
  const width =
    maxMemory > 0 && memory > 0 ? Math.max(4, Math.min(100, (memory / maxMemory) * 100)) : 0
  return (
    <div className="mt-1.5 h-1 rounded-full bg-muted">
      <div className="h-full rounded-full bg-foreground/45" style={{ width: `${width}%` }} />
    </div>
  )
}

function ResourceProcessRow({
  process,
  maxMemory,
  className
}: {
  process: ProcessMemoryDetail
  maxMemory: number
  className?: string
}): React.JSX.Element {
  const privateText =
    typeof process.privateMemory === 'number' && process.privateMemory > 0
      ? `Private ${formatResourceMemory(process.privateMemory)}`
      : null

  return (
    <div className={cn('px-3 py-2', className)}>
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              {process.role}
            </span>
            <span className="truncate text-[11px] font-medium text-foreground">
              {process.label}
            </span>
            <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
              pid {process.pid}
            </span>
          </div>
          {process.command ? (
            <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground/70">
              {process.command}
            </div>
          ) : null}
          <ProcessMemoryBar memory={process.memory} maxMemory={maxMemory} />
        </div>
        <div className="shrink-0">
          <div className={cn(PROCESS_METRIC_COLUMNS_CLS, 'text-[11px]')}>
            <span className={cn(PROCESS_CPU_COLUMN_CLS, 'text-muted-foreground')}>
              {formatResourceCpu(process.cpu)}
            </span>
            <span className={cn(PROCESS_MEM_COLUMN_CLS, 'font-medium text-foreground')}>
              {formatResourceMemory(process.memory)}
            </span>
            <span className={PROCESS_TRAILING_GUTTER_CLS} aria-hidden />
          </div>
          {privateText ? (
            <div className={cn(PROCESS_METRIC_COLUMNS_CLS, 'mt-0.5 text-[10px]')}>
              <span className={PROCESS_CPU_COLUMN_CLS} aria-hidden />
              <span className={cn(PROCESS_MEM_COLUMN_CLS, 'text-muted-foreground')}>
                {privateText}
              </span>
              <span className={PROCESS_TRAILING_GUTTER_CLS} aria-hidden />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

export function ResourceProcessDetailRows({
  processes,
  limit,
  className,
  rowClassName,
  emptyLabel = 'No process details sampled.'
}: {
  processes: readonly ProcessMemoryDetail[]
  limit: number
  className?: string
  rowClassName?: string
  emptyLabel?: string
}): React.JSX.Element {
  const rows = useMemo(() => getTopProcesses(processes, limit), [limit, processes])
  const maxMemory = rows[0]?.memory ?? 0

  if (rows.length === 0) {
    return (
      <div className={cn('px-3 py-3 text-[11px] text-muted-foreground', rowClassName)}>
        {emptyLabel}
      </div>
    )
  }

  return (
    <div className={cn('divide-y divide-border/30', className)}>
      {rows.map((process) => (
        <ResourceProcessRow
          key={`${process.pid}:${process.role}`}
          process={process}
          maxMemory={maxMemory}
          className={rowClassName}
        />
      ))}
    </div>
  )
}

export function ResourceProcessDisclosure({
  title,
  subtitle,
  metric,
  processes,
  limit,
  containerClassName,
  buttonClassName,
  panelClassName,
  rowClassName
}: {
  title: string
  subtitle: string
  metric?: string
  processes: readonly ProcessMemoryDetail[]
  limit: number
  containerClassName?: string
  buttonClassName?: string
  panelClassName?: string
  rowClassName?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)

  return (
    <div className={cn('border-t border-border/30', containerClassName)}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent/40',
          buttonClassName
        )}
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[11px] font-medium text-foreground">{title}</span>
          <span className="block truncate text-[10px] text-muted-foreground">{subtitle}</span>
        </span>
        {metric ? (
          <span className="shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
            {metric}
          </span>
        ) : null}
      </button>
      {open ? (
        <ResourceProcessDetailRows
          processes={processes}
          limit={limit}
          className={cn('border-t border-border/30 bg-background/70', panelClassName)}
          rowClassName={rowClassName}
        />
      ) : null}
    </div>
  )
}
