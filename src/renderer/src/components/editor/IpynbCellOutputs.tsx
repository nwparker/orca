import DOMPurify from 'dompurify'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { IpynbMarkdownCell } from './IpynbCellEditor'
import type { IpynbCell, IpynbOutput, IpynbOutputItem } from './ipynb-parse'

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

function getOutputIdentity(output: IpynbOutput): string {
  if (output.kind === 'stream') {
    return `stream:${output.name}:${output.text}`
  }
  if (output.kind === 'error') {
    return `error:${output.name}:${output.message}:${output.traceback}`
  }
  const items = output.items
    .map((item) => `${item.mime}:${JSON.stringify(item.value) ?? ''}`)
    .join('|')
  return `display:${output.outputType}:${output.executionCount ?? ''}:${items}`
}

function getKeyedOutputs(outputs: IpynbOutput[]): { key: string; output: IpynbOutput }[] {
  const occurrences = new Map<string, number>()
  return outputs.map((output) => {
    const identity = getOutputIdentity(output)
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    return { key: `${identity}:${occurrence}`, output }
  })
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
        'max-h-[420px] overflow-auto whitespace-pre-wrap px-3 py-2 font-mono text-xs leading-5 scrollbar-editor',
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
      <iframe
        title={translate('auto.components.editor.IpynbViewer.66a3f7d330', 'Notebook HTML output')}
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
        className="block h-80 w-full border-0 bg-background"
        srcDoc={html}
      />
    )
  }

  if (item.mime.startsWith('image/')) {
    const uri = dataUriForImage(item)
    return uri ? (
      <div className="flex max-w-full overflow-auto p-3 scrollbar-editor">
        <img src={uri} alt={item.mime} className="max-h-[520px] max-w-full object-contain" />
      </div>
    ) : null
  }

  if (item.mime === 'application/json' || item.mime.endsWith('+json')) {
    const text =
      typeof item.value === 'string' ? item.value : JSON.stringify(item.value ?? null, null, 2)
    return <PreformattedOutput text={text} />
  }
  if (item.mime === 'text/markdown') {
    return <IpynbMarkdownCell source={valueToText(item.value)} />
  }
  if (item.mime.startsWith('text/') || item.mime === 'application/javascript') {
    return <PreformattedOutput text={valueToText(item.value)} />
  }
  return null
}

export function IpynbCellOutputs({ cell }: { cell: IpynbCell }): React.JSX.Element | null {
  if (cell.outputs.length === 0) {
    return null
  }
  return (
    <div className="border-t border-border/50 bg-background">
      {getKeyedOutputs(cell.outputs).map(({ key, output }) => {
        if (output.kind === 'stream') {
          return <PreformattedOutput key={key} text={output.text} />
        }
        if (output.kind === 'error') {
          return (
            <div key={key} className="border-l-2 border-destructive">
              <PreformattedOutput
                error
                text={[output.name, output.message, output.traceback].filter(Boolean).join('\n')}
              />
            </div>
          )
        }
        const renderedItems = output.items
          .map((item) => <OutputItem key={item.mime} item={item} />)
          .filter(Boolean)
        return renderedItems.length > 0 ? (
          <div key={key} className="border-b border-border/40 last:border-b-0">
            {renderedItems}
          </div>
        ) : null
      })}
    </div>
  )
}
