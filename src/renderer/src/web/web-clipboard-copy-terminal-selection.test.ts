// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { copyClipboardTextViaExecCommand } from './web-clipboard-copy-fallback'

// Why a real DOM: the bug is purely about listener phase ordering, which only a
// DOM with genuine capture/bubble propagation can reproduce.

type ClipboardDataStub = {
  setData: (format: string, value: string) => void
  getData: (format: string) => string
}

function createClipboardDataStub(): ClipboardDataStub {
  const store = new Map<string, string>()
  return {
    setData(format, value) {
      store.set(format, value)
    },
    getData(format) {
      return store.get(format) ?? ''
    }
  }
}

/**
 * Stands in for xterm: a bubble-phase 'copy' listener on terminal.element that
 * overwrites text/plain with the terminal selection (xterm's copyHandler).
 */
function mountTerminalWithSelection(selectionText: string): HTMLElement {
  const terminalElement = document.createElement('div')
  document.body.appendChild(terminalElement)
  terminalElement.addEventListener('copy', (event) => {
    const clipboardData = (event as unknown as { clipboardData?: ClipboardDataStub }).clipboardData
    clipboardData?.setData('text/plain', selectionText)
    event.preventDefault()
  })
  return terminalElement
}

/**
 * Stands in for the browser's execCommand('copy'): dispatches one bubbling,
 * cancelable copy event from the element the DOM selection anchors to.
 */
function stubExecCommand(source: HTMLElement, clipboardData: ClipboardDataStub): void {
  ;(document as unknown as { execCommand: (command: string) => boolean }).execCommand = (
    command
  ) => {
    if (command !== 'copy') {
      return false
    }
    const event = new Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: clipboardData })
    source.dispatchEvent(event)
    return true
  }
}

describe('web copy fallback vs. the terminal selection', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('copies the requested text even when the selection anchor is inside a terminal', () => {
    // Every Orca copy affordance (Copy Pane ID, Copy Path, commit SHA, PR URL) leaves
    // the DOM selection inside the terminal, so execCommand('copy') dispatches from
    // there. A capture-phase handler sets text/plain FIRST and xterm's bubble handler
    // then overwrites it — and preventDefault does not stop propagation, so the copy
    // reports success while the clipboard holds the terminal selection.
    const terminalElement = mountTerminalWithSelection('rm -rf ./secret-dir')
    const clipboardData = createClipboardDataStub()
    stubExecCommand(terminalElement, clipboardData)

    expect(copyClipboardTextViaExecCommand('/Users/me/repo/src/index.ts', document)).toBe(true)
    expect(clipboardData.getData('text/plain')).toBe('/Users/me/repo/src/index.ts')
  })

  it('wins over a document-level copy handler registered after it', () => {
    const source = document.createElement('div')
    document.body.appendChild(source)
    const clipboardData = createClipboardDataStub()
    stubExecCommand(source, clipboardData)
    document.addEventListener('copy', (event) => {
      const data = (event as unknown as { clipboardData?: ClipboardDataStub }).clipboardData
      data?.setData('text/plain', 'late document handler')
    })

    expect(copyClipboardTextViaExecCommand('pane-42', document)).toBe(true)
    expect(clipboardData.getData('text/plain')).toBe('pane-42')
  })
})
