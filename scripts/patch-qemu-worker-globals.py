#!/usr/bin/env python3
"""Make the Emscripten/SDL glue safe to run inside Web Workers.

QEMU's main thread runs in a pthread (a Web Worker) because of -sPROXY_TO_PTHREAD=1.
Workers have no `window`, `document` or `screen`, so SDL's startup call
(emscripten_get_screen_size -> screen.width) throws "ReferenceError: screen is not
defined" and kills the QEMU main thread right after the monitor prompt is printed.
This replaces those reads with guarded fallbacks. Safe to run more than once.
"""
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
src = path.read_text()
MARK = "/* wasmdroid: worker-safe screen/window */"
if MARK in src:
    print(f"{path}: already patched")
    sys.exit(0)

W, H = 1280, 720
SCR_W = f'(typeof screen !== "undefined" ? screen.width : {W})'
SCR_H = f'(typeof screen !== "undefined" ? screen.height : {H})'

n = 0
def sub(old, new, count_expected):
    global src, n
    c = src.count(old)
    if c != count_expected:
        sys.exit(f"expected {count_expected} x {old!r}, found {c}; build output changed, not patching")
    src = src.replace(old, new)
    n += c

sub("= screen.width;", f"= {SCR_W};", 2)
sub("= screen.height;", f"= {SCR_H};", 2)
sub("Math.min(screen.width / w, screen.height / h)", f"Math.min({SCR_W} / w, {SCR_H} / h)", 1)
sub("strategy.softFullscreen ? innerWidth : screen.width", f'strategy.softFullscreen ? innerWidth : {SCR_W}', 1)
sub("strategy.softFullscreen ? innerHeight : screen.height", f'strategy.softFullscreen ? innerHeight : {SCR_H}', 1)
sub("if (target == screen) return", 'if (typeof screen !== "undefined" && target == screen) return', 1)
sub("() => window.innerWidth", f'() => (typeof window !== "undefined" ? window.innerWidth : {W})', 1)
sub("() => window.innerHeight", f'() => (typeof window !== "undefined" ? window.innerHeight : {H})', 1)

sub("if (!document || !document.body ||", 'if (typeof document === "undefined" || !document || !document.body ||', 1)
sub(" var rtn = func.apply(null, proxiedJSCallArgs);\n PThread.currentProxiedOperationCallerThread = 0;",
    """ var rtn;
 try {
  rtn = func.apply(null, proxiedJSCallArgs);
 } catch (e) {
  /* Browser-only API called on a Worker (no document/window/screen): report "not supported" instead of killing QEMU's thread. */
  if (e instanceof ReferenceError && /\\b(document|window|screen) is not defined/.test(e.message)) {
   rtn = -1;
   if (!globalThis.__wasmdroidWarned) { globalThis.__wasmdroidWarned = 1; console.warn("[wasmdroid] ignored browser-only call in worker: " + e.message); }
  } else {
   PThread.currentProxiedOperationCallerThread = 0;
   throw e;
  }
 }
 PThread.currentProxiedOperationCallerThread = 0;""", 1)

path.write_text(MARK + "\n" + src)
print(f"{path}: patched {n} places")
