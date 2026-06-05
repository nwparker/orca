// @vitest-environment happy-dom

import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProcessMemoryDetail } from '../../../../shared/types'
import { ResourceProcessDetailRows, ResourceProcessDisclosure } from './ResourceProcessDetails'

const roots: Root[] = []

function makeProcesses(): ProcessMemoryDetail[] {
  return [
    {
      pid: 10,
      role: 'Renderer',
      label: 'Renderer process',
      command: 'Orca Helper --type=renderer',
      cpu: 0.5,
      memory: 192 * 1024 * 1024
    },
    {
      pid: 20,
      role: 'Main',
      label: 'Main process',
      command: 'Orca',
      cpu: 0.2,
      memory: 64 * 1024 * 1024
    }
  ]
}

async function renderNode(node: ReactNode): Promise<HTMLDivElement> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(node)
  })
  return container
}

function clickButton(container: HTMLElement, text: string): void {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  )
  if (!button) {
    throw new Error(`Button not found: ${text}`)
  }
  button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('ResourceProcessDetails', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of roots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  it('keeps process rows hidden until the disclosure is opened', async () => {
    const container = await renderNode(
      <ResourceProcessDisclosure
        title="Local processes"
        subtitle="2 sampled processes"
        metric="256.0 MB"
        processes={makeProcesses()}
        limit={8}
      />
    )

    expect(container.textContent).toContain('Local processes')
    expect(container.textContent).not.toContain('Renderer process')

    await act(async () => clickButton(container, 'Local processes'))
    expect(container.textContent).toContain('Renderer process')
    expect(container.textContent).toContain('Orca Helper --type=renderer')
  })

  it('sorts direct process rows by memory descending', async () => {
    const container = await renderNode(
      <ResourceProcessDetailRows processes={makeProcesses().reverse()} limit={8} />
    )

    const text = container.textContent ?? ''
    expect(text.indexOf('Renderer process')).toBeLessThan(text.indexOf('Main process'))
  })
})
