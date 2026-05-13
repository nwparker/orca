import React, { useLayoutEffect, useMemo, useRef } from 'react'
import DOMPurify from 'dompurify'
import Markdown from 'react-markdown'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize from 'rehype-sanitize'
import remarkGfm from 'remark-gfm'
import { AlertCircle, Braces, FileCode2, Play } from 'lucide-react'
import { computeEditorFontSize } from '@/lib/editor-font-zoom'
import { useAppStore } from '@/store'
import { scrollTopCache, setWithLRU } from '@/lib/scroll-cache'
import { cn } from '@/lib/utils'
import MonacoCodeExcerpt from './MonacoCodeExcerpt'
import { parseIpynb, type IpynbCell, type IpynbOutputItem } from './ipynb-parse'

type IpynbViewerProps = {
  content: string
  filePath: string
  scrollCacheKey: string
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
  index
}: {
  cell: IpynbCell
  index: number
}): React.JSX.Element {
  const Icon = cell.kind === 'code' ? Play : cell.kind === 'markdown' ? FileCode2 : Braces
  const executionLabel = cell.kind === 'code' ? `In [${cell.executionCount ?? ' '}]:` : cell.kind
  return (
    <div className="flex items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5" />
      <span className="font-mono">{executionLabel}</span>
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

function CodeCell({ cell }: { cell: IpynbCell }): React.JSX.Element {
  const lines = cell.source.length > 0 ? cell.source.replace(/\n$/, '').split('\n') : ['']
  return (
    <div className="bg-editor-surface">
      <MonacoCodeExcerpt
        lines={lines}
        firstLineNumber={1}
        highlightedStartLine={-1}
        highlightedEndLine={-1}
        language={cell.language}
      />
    </div>
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
  scrollCacheKey
}: IpynbViewerProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const settings = useAppStore((s) => s.settings)
  const editorFontZoomLevel = useAppStore((s) => s.editorFontZoomLevel)
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
              <NotebookCellHeader cell={cell} index={index} />
              {cell.kind === 'markdown' ? (
                <MarkdownCell source={cell.source} />
              ) : cell.kind === 'code' ? (
                <CodeCell cell={cell} />
              ) : (
                <PreformattedOutput text={cell.source} />
              )}
              <CellOutputs cell={cell} />
            </section>
          ))
        )}
      </div>
    </div>
  )
}
