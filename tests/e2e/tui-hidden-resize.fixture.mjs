#!/usr/bin/env node

let exiting = false
let frame = 0

function getTerminalSize() {
  return {
    cols: process.stdout.columns || 80,
    rows: process.stdout.rows || 24
  }
}

function write(value) {
  process.stdout.write(value)
}

function paintLine(row, text, cols) {
  const width = Math.max(cols - 1, 1)
  write(`\x1b[${row};1H${text.padEnd(width).slice(0, width)}`)
}

function paintFullWidthBand(row, cols) {
  const width = Math.max(cols, 1)
  write(`\x1b[${row};1H\x1b[48;5;46m${' '.repeat(width)}\x1b[0m`)
}

function paintRightEdgeMarker(row, text, cols) {
  const markerColumn = Math.max(1, cols - text.length + 1)
  write(`\x1b[${row};${markerColumn}H${text}`)
}

function render(reason) {
  if (exiting) {
    return
  }
  frame += 1
  const { cols, rows } = getTerminalSize()

  write('\x1b[?1049h')
  write('\x1b[?2004h')
  write('\x1b[?25l')
  write('\x1b[?2026h')
  write('\x1b[0m\x1b[1;1H\x1b[2J')
  paintFullWidthBand(1, cols)
  paintLine(2, 'TUI_RESIZE_STATUS:clean', cols)
  paintLine(3, `TUI_RESIZE_FRAME:${frame}`, cols)
  paintLine(4, `TUI_RESIZE_REASON:${reason}`, cols)
  paintLine(5, `TUI_RESIZE_SIZE:${cols}x${rows}`, cols)
  paintLine(6, 'TUI_RESIZE_VISUAL_REGRESSION:hidden-resize', cols)
  paintRightEdgeMarker(7, 'TUI_RESIZE_RIGHT_EDGE:OK', cols)
  write('\x1b[?2026l')
  write(`\x1b]777;tui-hidden-resize-frame-${frame}-${reason}-${cols}x${rows}\x07`)
}

function shutdown() {
  if (exiting) {
    return
  }
  exiting = true
  write('\x1b[?2026l')
  write('\x1b[?25h')
  write('\x1b[?2004l')
  write('\x1b[?1049l')
  process.exit(0)
}

process.on('SIGWINCH', () => render('sigwinch'))
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true)
}
process.stdin.resume()
process.stdin.on('data', (chunk) => {
  if (chunk.includes(0x03) || chunk.includes(0x04)) {
    shutdown()
  }
})

render('initial')
