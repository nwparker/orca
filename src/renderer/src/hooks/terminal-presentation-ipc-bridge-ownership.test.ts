import { describe, expect, it } from 'vitest'
import { setupTerminalCreateSurfacing } from './ipc-events-terminal-create-test-harness'

describe('terminal presentation PTY ownership', () => {
  it('fails closed when persisted PTY ownership is ambiguous', async () => {
    const scenario = await setupTerminalCreateSurfacing(() => false)
    const { storeState, createTerminalListenerRef, createTab, replyTerminalCreate } = scenario
    const createTerminalListener = createTerminalListenerRef.current
    if (!createTerminalListener) {
      throw new Error('Expected create-terminal listener to be registered')
    }
    storeState.tabsByWorktree = {
      'wt-2': [
        { id: 'tab-primary', ptyId: 'pty-duplicate' },
        { id: 'tab-stale', ptyId: null }
      ]
    }
    storeState.terminalLayoutsByTabId = {
      'tab-stale': {
        ptyIdsByLeafId: { 'leaf-stale': 'pty-duplicate' }
      }
    }

    createTerminalListener({
      requestId: 'req-ambiguous-pty',
      worktreeId: 'wt-2',
      ptyId: 'pty-duplicate'
    })

    expect(createTab).not.toHaveBeenCalled()
    expect(replyTerminalCreate).toHaveBeenCalledWith({
      requestId: 'req-ambiguous-pty',
      error: 'Terminal creation is unavailable because the PTY owner is ambiguous'
    })
  })
})
