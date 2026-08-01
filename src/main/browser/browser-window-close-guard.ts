// Why: Chromium can destroy an embedded guest even when window.close() should be ignored.
export const BROWSER_WINDOW_CLOSE_GUARD_SCRIPT = `(function() {
  var ignoreWindowClose = function() {};
  try {
    Object.defineProperty(window, 'close', {
      configurable: false,
      enumerable: false,
      writable: false,
      value: ignoreWindowClose
    });
  } catch {
    try {
      window.close = ignoreWindowClose;
    } catch {}
  }
})()`
