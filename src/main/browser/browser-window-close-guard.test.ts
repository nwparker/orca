import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

import { BROWSER_WINDOW_CLOSE_GUARD_SCRIPT } from './browser-window-close-guard'

describe('BROWSER_WINDOW_CLOSE_GUARD_SCRIPT', () => {
  it('turns window.close into a no-op', () => {
    const nativeClose = () => 'closed'
    const context = {
      Object,
      window: { close: nativeClose }
    }

    runInNewContext(BROWSER_WINDOW_CLOSE_GUARD_SCRIPT, context)

    expect(context.window.close()).toBeUndefined()
    expect(context.window.close).not.toBe(nativeClose)
  })

  it('does not allow page code to restore the native close function', () => {
    const nativeClose = () => 'closed'
    const context = {
      Object,
      window: { close: nativeClose }
    }

    runInNewContext(
      `${BROWSER_WINDOW_CLOSE_GUARD_SCRIPT}
       window.close = function() { return 'restored' }`,
      context
    )

    expect(context.window.close()).toBeUndefined()
  })
})
