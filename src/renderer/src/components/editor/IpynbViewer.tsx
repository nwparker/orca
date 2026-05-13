/* eslint-disable max-lines -- Why: notebook editing, output rendering, and cell
controls share one parsed document/update path for this first notebook editor
slice; splitting before the model stabilizes would make save/run mutations
harder to audit. */
import React, { useLayoutEffect, useMemo, useRef, useState } from 'react'
import DOMPurify from 'dompurify'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { AlertCircle, Braces, FileCode2, Loader2, Play, Plus, Trash2 } from 'lucide-react'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  deleteIpynbCell,
  insertIpynbCell,
  parseIpynb,
  updateIpynbCellKind,
  updateIpynbCellOutputs,
  updateIpynbCellSource,
  type IpynbCell,
  type IpynbCellKind,
  type IpynbOutputItem
} from './ipynb-parse'

type IpynbViewerProps = {
  content: string
  filePath: string
  worktreeId: string
  scrollCacheKey: string
  onContentChange: (content: string) => void
  onSave: (content: string) => Promise<void>
}

function valueToText(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map((item) => String(item ?? '')).join('')
  }
  if (typeof value === 'string') {
    return value
  }
  if (value === undefined || value === null) {
    return ''
  }
  return typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)
}

function dataUriForImage(item: IpynbOutputItem): string | null {
  const value = valueToText(item.value).replace(/\s/g, '')
  if (!value) {
    return null
  }
  if (item.mime === 'image/svg+xml') {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(valueToText(item.value))}`
  }
  return `data:${item.mime};base64,${value}`
}

function NotebookCellHeader({
  cell,
  index,
  running,
  onRun,
  onKindChange,
  onInsertBelow,
  onDelete
}: {
  cell: IpynbCell
  index: number
  running: boolean
  onRun: () => void
  onKindChange: (kind: IpynbCellKind) => void
  onInsertBelow: (kind: IpynbCellKind) => void
  onDelete: () => void
}): React.JSX.Element {
  const Icon = cell.kind === 'code' ? Play : cell.kind === 'markdown' ? FileCode2 : Braces
  const executionLabel = cell.kind === 'code' ? `In [${cell.executionCount ?? ' '}]:` : cell.kind
  return (
    <div className="flex items-center gap-2 border-b border-border/50 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5" />
      <span className="font-mono">{executionLabel}</span>
      <select
        value={cell.kind}
        onChange={(event) => onKindChange(event.target.value as IpynbCellKind)}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
      >
        <option value="code">Code</option>
        <option value="markdown">Markdown</option>
        <option value="raw">Raw</option>
      </select>
      {cell.kind === 'code' ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              disabled={running}
              onClick={onRun}
            >
              {running ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Play className="size-3.5" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Run cell</TooltipContent>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onInsertBelow('code')}
          >
            <Plus className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Add code cell</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7"
            onClick={() => onInsertBelow('markdown')}
          >
            <FileCode2 className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Add markdown cell</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" variant="ghost" size="icon" className="size-7" onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>Delete cell</TooltipContent>
      </Tooltip>
      <span className="ml-auto font-mono">#{index + 1}</span>
    </div>
  )
}

function MarkdownCell({ source }: { source: string }): React.JSX.Element {
  return (
    <div className="markdown-preview-body px-4 py-3 text-sm">
      <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw, rehypeSanitize]}>
        {source || '\u00a0'}
      </Markdown>
    </div>
  )
}

function CodeCell({
  cell,
  onChange
}: {
  cell: IpynbCell
  onChange: (source: string) => void
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const fontSize = computeEditorFontSize(settings?.terminalFontSize ?? 13, editorFontZoomLevel)
  const lineCount = Math.max(3, cell.source.split('\n').length + 1)
  return (
    <textarea
      value={cell.source}
      onChange={(event) => onChange(event.target.value)}
      spellCheck={false}
      className="block w-full resize-y border-0 bg-editor-surface px-4 py-3 font-mono text-foreground outline-none focus:ring-1 focus:ring-ring"
      style={{
        minHeight: Math.min(520, Math.max(96, lineCount * (fontSize + 8))),
        fontSize,
        fontFamily: settings?.terminalFontFamily || 'monospace'
      }}
    />
  )
}

function EditableTextCell({
  source,
  onChange
}: {
  source: string
  onChange: (source: string) => void
}): React.JSX.Element {
  return (
    <textarea
      value={source}
      onChange={(event) => onChange(event.target.value)}
      className="block min-h-24 w-full resize-y border-0 bg-background px-4 py-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
    />
  )
}

function PreformattedOutput({
  text,
  error = false
}: {
  text: string
  error?: boolean
}): React.JSX.Element {
  return (
    <pre
      className={cn(
        'max-h-[420px] overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-5',
        error ? 'text-destructive' : 'text-foreground'
      )}
    >
      {text}
    </pre>
  )
}

function OutputItem({ item }: { item: IpynbOutputItem }): React.JSX.Element | null {
  if (item.mime === 'text/html') {
    const html = DOMPurify.sanitize(valueToText(item.value), {
      USE_PROFILES: { html: true, svg: true, svgFilters: true }
    })
    return (
      <div
        className="markdown-preview-body max-w-full overflow-auto px-3 py-2 text-sm"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }

  if (item.mime.startsWith('image/')) {
    const uri = dataUriForImage(item)
    if (!uri) {
      return null
    }
    return (
      <div className="flex max-w-full overflow-auto p-3">
        <img src={uri} alt={item.mime} className="max-h-[520px] max-w-full object-contain" />
      </div>
    )
  }

  if (item.mime === 'application/json' || item.mime.endsWith('+json')) {
    const text =
      typeof item.value === 'string' ? item.value : JSON.stringify(item.value ?? null, null, 2)
    return <PreformattedOutput text={text} />
  }

  if (item.mime === 'text/markdown') {
    return <MarkdownCell source={valueToText(item.value)} />
  }

  if (item.mime.startsWith('text/') || item.mime === 'application/javascript') {
    return <PreformattedOutput text={valueToText(item.value)} />
  }

  return null
}

function CellOutputs({ cell }: { cell: IpynbCell }): React.JSX.Element | null {
  if (cell.outputs.length === 0) {
    return null
  }

  return (
    <div className="border-t border-border/50 bg-background">
      {cell.outputs.map((output, index) => {
        if (output.kind === 'stream') {
          return <PreformattedOutput key={index} text={output.text} />
        }
        if (output.kind === 'error') {
          return (
            <div key={index} className="border-l-2 border-destructive">
              <PreformattedOutput
                error
                text={[output.name, output.message, output.traceback].filter(Boolean).join('\n')}
              />
            </div>
          )
        }
        const renderedItems = output.items
          .map((item, itemIndex) => <OutputItem key={`${item.mime}-${itemIndex}`} item={item} />)
          .filter(Boolean)
        if (renderedItems.length === 0) {
          return null
        }
        return (
          <div key={index} className="border-b border-border/40 last:border-b-0">
            {renderedItems}
          </div>
        )
      })}
    </div>
  )
}

export default function IpynbViewer({
  content,
  filePath,
  worktreeId,
  scrollCacheKey,
  onContentChange,
  onSave
}: IpynbViewerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
  const [runningCellIndex, setRunningCellIndex] = useState<number | null>(null)
  const [runError, setRunError] = useState<string | null>(null)
  const fontSize = computeEditorFontSize(13, editorFontZoomLevel)
  const parsed = useMemo(() => {
    try {
      return { notebook: parseIpynb(content), error: null as string | null }
    } catch (error) {
      return {
        notebook: null,
        error: error instanceof Error ? error.message : 'Invalid notebook'
      }
    }
  }, [content])

  useLayoutEffect(() => {
    const container = rootRef.current
    if (!container) {
      return
    }
    let throttleTimer: ReturnType<typeof setTimeout> | null = null
    const onScroll = (): void => {
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      throttleTimer = setTimeout(() => {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
        throttleTimer = null
      }, 150)
    }
    container.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      if (container.scrollHeight > container.clientHeight || container.scrollTop > 0) {
        setWithLRU(scrollTopCache, scrollCacheKey, container.scrollTop)
      }
      if (throttleTimer !== null) {
        clearTimeout(throttleTimer)
      }
      container.removeEventListener('scroll', onScroll)
    }
  }, [scrollCacheKey])

  useLayoutEffect(() => {
    const container = rootRef.current
    const targetScrollTop = scrollTopCache.get(scrollCacheKey)
    if (!container || targetScrollTop === undefined) {
      return
    }
    container.scrollTop = targetScrollTop
  }, [scrollCacheKey, content])

  if (parsed.error || !parsed.notebook) {
    return (
      <div className="flex h-full items-center justify-center bg-editor-surface p-6 text-sm text-muted-foreground">
        <div className="flex max-w-md items-start gap-3 rounded-md border border-border bg-background p-4">
          <AlertCircle className="mt-0.5 size-4 text-destructive" />
          <div>
            <div className="font-medium text-foreground">Unable to render notebook</div>
            <div className="mt-1">{parsed.error}</div>
          </div>
        </div>
      </div>
    )
  }

  const { notebook } = parsed
  const applyContent = (nextContent: string): void => {
    onContentChange(nextContent)
  }
  const updateCellSource = (index: number, source: string): void => {
    applyContent(updateIpynbCellSource(content, index, source))
  }
  const updateCellKind = (index: number, kind: IpynbCellKind): void => {
    applyContent(updateIpynbCellKind(content, index, kind, notebook.language))
  }
  const insertCell = (index: number, kind: IpynbCellKind): void => {
    applyContent(insertIpynbCell(content, index, kind, notebook.language))
  }
  const deleteCell = (index: number): void => {
    applyContent(deleteIpynbCell(content, index))
  }
  const runCell = async (index: number): Promise<void> => {
    const cell = notebook.cells[index]
    if (!cell || cell.kind !== 'code' || runningCellIndex !== null) {
      return
    }
    setRunError(null)
    setRunningCellIndex(index)
    try {
      await onSave(content)
      const result = await window.api.notebook.runPythonCell({
        filePath,
        code: cell.source,
        preamble: notebook.cells
          .slice(0, index)
          .filter((previousCell) => previousCell.kind === 'code')
          .map((previousCell) => previousCell.source)
          .join('\n\n'),
        connectionId: getConnectionId(worktreeId) ?? undefined
      })
      applyContent(updateIpynbCellOutputs(content, index, result))
    } catch (error) {
      setRunError(error instanceof Error ? error.message : String(error))
    } finally {
      setRunningCellIndex(null)
    }
  }

  return (
    <div
      ref={rootRef}
      className="h-full min-h-0 overflow-auto bg-editor-surface scrollbar-editor"
      style={{ fontSize, fontFamily: settings?.terminalFontFamily || undefined }}
    >
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border/60 bg-background/95 px-4 py-2 text-xs text-muted-foreground backdrop-blur">
        <span className="font-medium text-foreground">{filePath.split(/[/\\]/).pop()}</span>
        <span>{notebook.cells.length} cells</span>
        <span>{notebook.language}</span>
        {notebook.kernelName ? <span>{notebook.kernelName}</span> : null}
        {runError ? <span className="text-destructive">{runError}</span> : null}
        <span className="ml-auto font-mono">nbformat {notebook.nbformat}</span>
      </div>
      <div className="mx-auto flex max-w-[980px] flex-col gap-3 px-5 py-5">
        {notebook.cells.length === 0 ? (
          <div className="flex items-center justify-center rounded-md border border-border bg-background p-8 text-sm text-muted-foreground">
            Empty notebook
          </div>
        ) : (
          notebook.cells.map((cell, index) => (
            <section
              key={cell.id ?? index}
              className="overflow-hidden rounded-md border border-border bg-background"
            >
              <NotebookCellHeader
                cell={cell}
                index={index}
                running={runningCellIndex === index}
                onRun={() => void runCell(index)}
                onKindChange={(kind) => updateCellKind(index, kind)}
                onInsertBelow={(kind) => insertCell(index + 1, kind)}
                onDelete={() => deleteCell(index)}
              />
              {cell.kind === 'markdown' ? (
                <div className="grid gap-0 lg:grid-cols-2">
                  <EditableTextCell
                    source={cell.source}
                    onChange={(source) => updateCellSource(index, source)}
                  />
                  <div className="border-t border-border/50 lg:border-l lg:border-t-0">
                    <MarkdownCell source={cell.source} />
                  </div>
                </div>
              ) : cell.kind === 'code' ? (
                <CodeCell cell={cell} onChange={(source) => updateCellSource(index, source)} />
              ) : (
                <EditableTextCell
                  source={cell.source}
                  onChange={(source) => updateCellSource(index, source)}
                />
              )}
              <CellOutputs cell={cell} />
            </section>
          ))
        )}
      </div>
    </div>
  )
}
