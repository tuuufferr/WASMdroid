#!/usr/bin/env python3
from pathlib import Path
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: patch-qemu-egl.py path/to/qemu-system-x86_64.js")
p = Path(sys.argv[1])
s = p.read_text(encoding="utf-8")
functions = re.findall(r"(?m)^function (_egl[A-Za-z0-9_]+)\(", s)
if not functions:
    raise SystemExit("No EGL wrappers found in runtime")
expected = len(functions)
pattern = re.compile(
    r"(?m)^(function _egl[A-Za-z0-9_]+\([^\n]*\) \{\n)"
    r"[ \t]*if \(ENVIRONMENT_IS_PTHREAD\) return proxyToMainThread\([^\n]*\);\n"
)
patched, n = pattern.subn(r"\1", s)
remaining = re.findall(
    r"(?m)^function (_egl[A-Za-z0-9_]+)\([^\n]*\) \{\n"
    r"[ \t]*if \(ENVIRONMENT_IS_PTHREAD\) return proxyToMainThread",
    patched,
)
if remaining or n not in (0, expected):
    raise SystemExit(f"EGL patch incomplete: removed {n}/{expected}; remaining={remaining}")
if n:
    p.write_text(patched, encoding="utf-8")
    print(f"Patched {n} EGL proxy wrappers in {p}")
else:
    print(f"All EGL wrappers already patched in {p}")
