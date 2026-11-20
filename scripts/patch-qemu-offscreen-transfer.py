#!/usr/bin/env python3
from pathlib import Path
import sys


if len(sys.argv) != 2:
    raise SystemExit("Usage: patch-qemu-offscreen-transfer.py runtime.js")


p = Path(sys.argv[1])
s = p.read_text()
a = s.find("function ___pthread_create_js(")
b = s.find("function ___pthread_kill_js(", a)


if a < 0 or b < 0:
    raise SystemExit("Could not locate Emscripten pthread creation code")


part = s[a:b]


if "if (canvas instanceof OffscreenCanvas)" in part:
    print("OffscreenCanvas handoff already patched")
    raise SystemExit(0)


needle = "    if (canvas.transferControlToOffscreen) {"
if part.count(needle) != 1:
    raise SystemExit("Unexpected Emscripten runtime; refusing unsafe patch")


replacement = (
"    if (canvas instanceof OffscreenCanvas) {\n"
"     if (!canvas.canvasSharedPtr) {\n"
"      canvas.canvasSharedPtr = _malloc(12);\n"
"      HEAP32[((canvas.canvasSharedPtr) >>> 2) >>> 0] = canvas.width;\n"
"      HEAP32[(((canvas.canvasSharedPtr) + (4)) >>> 2) >>> 0] = canvas.height;\n"
"      HEAPU32[(((canvas.canvasSharedPtr) + (8)) >>> 2) >>> 0] = 0;\n"
"     }\n"
"     offscreenCanvasInfo = {\n"
"      offscreenCanvas: canvas,\n"
"      canvasSharedPtr: canvas.canvasSharedPtr,\n"
"      id: canvas.id\n"
"     };\n"
"     Module[\"canvas\"] = null;\n"
"    } else if (canvas.transferControlToOffscreen) {"
)


part = part.replace(needle, replacement, 1)
p.write_text(s[:a] + part + s[b:])
print("Patched nested OffscreenCanvas handoff")
