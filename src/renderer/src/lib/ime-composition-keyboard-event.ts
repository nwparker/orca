import type { KeyboardEvent as ReactKeyboardEvent } from 'react'

type ImeKeyboardEvent = KeyboardEvent | ReactKeyboardEvent

/** Detects IME-owned keydowns, including engines that only report keyCode 229. */
export function isImeCompositionKeyDown(event: ImeKeyboardEvent): boolean {
  const nativeEvent = 'nativeEvent' in event ? event.nativeEvent : event
  return nativeEvent.isComposing || nativeEvent.keyCode === 229
}
