import { Children, isValidElement, useEffect, useMemo, useState, type ComponentProps } from 'react'
import CommentMarkdown, {
  type CommentMarkdownExtension,
  type CommentMarkdownLinkClickHandler
} from '@/components/sidebar/CommentMarkdown'
import { createDocumentCommentMarkdownComponents } from '@/components/sidebar/comment-markdown-element-renderers'
import { cn } from '@/lib/utils'
import { withoutPendingNativeChatVisualDirectiveTail } from '../../../../shared/native-chat-visual-directive'
import { NativeChatMarkdownRowKeyContext } from './native-chat-disclosure-store'
import { useNativeChatVisualMarkdownExtension } from './native-chat-visual-markdown-extension'
import { useNativeChatFileLinkExists } from './use-native-chat-file-link-existence'
import {
  NativeChatMarkdownImage,
  NativeChatMarkdownImageLinkContext
} from './NativeChatMarkdownImage'
import './native-chat-markdown.css'

/** Existing words stay opaque when a reply first starts growing. */
function useWordFadeArmed(fadeWords: boolean): boolean {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!fadeWords) {
      setArmed(false)
      return
    }
    const frame = requestAnimationFrame(() => setArmed(true))
    return () => cancelAnimationFrame(frame)
  }, [fadeWords])
  return armed && fadeWords
}

type NativeChatMarkdownProps = Omit<ComponentProps<typeof CommentMarkdown>, 'fileLinkExists'> & {
  /** Underline file paths in the text that exist in the chat's workspace. */
  linkifyFilePaths?: boolean
  visualMessageId?: string
  streaming?: boolean
  /** The transcript row's identity, so reader choices inside the text outlive the row's mount. */
  rowKey?: string
}

function createNativeChatImageExtension(
  visualExtension: CommentMarkdownExtension | undefined,
  onLinkClick: CommentMarkdownLinkClickHandler | undefined
): CommentMarkdownExtension {
  const Anchor = createDocumentCommentMarkdownComponents(onLinkClick).a
  return {
    remarkPlugins: visualExtension?.remarkPlugins ?? [],
    sanitizeAttributes: visualExtension?.sanitizeAttributes ?? {},
    components: {
      ...visualExtension?.components,
      img: ({ src, alt }) => (
        <NativeChatMarkdownImage src={src} alt={alt} onLinkClick={onLinkClick} />
      ),
      a: (props) => {
        if (
          props.node?.children.some((child) => child.type === 'element' && child.tagName === 'img')
        ) {
          return Children.map(props.children, (child) =>
            isValidElement<{ node?: { tagName: string } }>(child) &&
            child.props.node?.tagName === 'img' ? (
              <NativeChatMarkdownImageLinkContext.Provider value={props.href}>
                <span data-native-chat-link-href={props.href}>{child}</span>
              </NativeChatMarkdownImageLinkContext.Provider>
            ) : typeof Anchor === 'function' ? (
              <Anchor {...props}>{child}</Anchor>
            ) : (
              <a href={props.href}>{child}</a>
            )
          )
        }
        return typeof Anchor === 'function' ? <Anchor {...props} /> : <a {...props} />
      }
    }
  }
}

export function NativeChatMarkdown({
  className,
  linkifyFilePaths = false,
  fadeWords = false,
  visualMessageId,
  streaming = false,
  rowKey,
  content,
  variant,
  onLinkClick,
  ...props
}: NativeChatMarkdownProps): React.JSX.Element {
  const wordFadeArmed = useWordFadeArmed(fadeWords)
  const visualExtension = useNativeChatVisualMarkdownExtension(visualMessageId)
  const extension = useMemo(
    () =>
      variant === 'document'
        ? createNativeChatImageExtension(visualExtension, onLinkClick)
        : visualExtension,
    [onLinkClick, variant, visualExtension]
  )
  const fileLinkExists = useNativeChatFileLinkExists(linkifyFilePaths, streaming)
  return (
    <NativeChatMarkdownRowKeyContext.Provider value={rowKey}>
      <CommentMarkdown
        {...props}
        variant={variant}
        onLinkClick={onLinkClick}
        content={
          visualExtension && streaming
            ? withoutPendingNativeChatVisualDirectiveTail(content)
            : content
        }
        extension={extension}
        fileLinkExists={fileLinkExists}
        fadeWords={fadeWords}
        renderMermaid={!streaming}
        keepMermaidSourceWhilePending
        data-word-fade={wordFadeArmed ? '' : undefined}
        data-block-fade={wordFadeArmed && streaming ? '' : undefined}
        className={cn('native-chat-markdown', className)}
      />
    </NativeChatMarkdownRowKeyContext.Provider>
  )
}
