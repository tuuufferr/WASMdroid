#!/usr/bin/env bash
# WASMdroid browser graphics + static-hosting fixes.
# Run from anywhere inside the Codespaces checkout:
#   bash apply_wasmdroid_fixes.sh
set -Eeuo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [[ ! -f "$ROOT/web/app.js" && -f "$ROOT/workspaces/codespaces-blank/android-wasm/web/app.js" ]]; then
  ROOT="$ROOT/workspaces/codespaces-blank/android-wasm"
fi
[[ -f "$ROOT/web/app.js" && -f "$ROOT/BUILD_QEMU_WASM.sh" ]] || {
  echo "ERROR: Run this from inside the WASMdroid repository/Codespace."; exit 2;
}

BACKUP="${TMPDIR:-/tmp}/wasmdroid-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP"
for f in web/app.js web/index.html web/qemu-wasm/worker.js web/qemu-wasm/qemu-system-x86_64.js BUILD_QEMU_WASM.sh README.md README_START_HERE.md web/_headers STATIC_DEPLOYMENT.md scripts/patch-qemu-egl.py; do
  if [[ -f "$ROOT/$f" ]]; then mkdir -p "$BACKUP/$(dirname "$f")"; cp -p "$ROOT/$f" "$BACKUP/$f"; fi
done
echo "Backups: $BACKUP"

python3 - "$ROOT" <<'PY'
from pathlib import Path
import subprocess, sys

R = Path(sys.argv[1])

def get(p):
    f = R / p
    if not f.is_file():
        raise SystemExit(f"Missing required file: {p}")
    return f.read_text(encoding="utf-8")

def put(p, s):
    f = R / p
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(s, encoding="utf-8")
    print("Updated", p)

def sub(p, old, new, name):
    s = get(p)
    if new in s:
        print("Already applied:", name)
        return
    n = s.count(old)
    if n != 1:
        raise SystemExit(f"Cannot safely patch {p}: expected 1 occurrence for {name}, found {n}.")
    put(p, s.replace(old, new, 1))

# A reproducible patcher for the EGL wrappers in the pinned generated runtime.
patcher = r"""#!/usr/bin/env python3
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
"""
put("scripts/patch-qemu-egl.py", patcher)

# Apply this automatically after every future Emscripten runtime build.
marker = 'docker cp "$CONTAINER:/build/node_modules/xterm-pty/LICENSE.txt" "$OUTPUT/NOTICE-xterm-pty.txt"\n'
sub(
    "BUILD_QEMU_WASM.sh", marker,
    marker + '\n# Keep EGL calls on the pthread that owns the transferred OffscreenCanvas.\n'
             'python3 "$ROOT/scripts/patch-qemu-egl.py" "$OUTPUT/qemu-system-x86_64.js"\n',
    "automatic EGL patch on future builds",
)
runtime = R / "web/qemu-wasm/qemu-system-x86_64.js"
if runtime.is_file():
    subprocess.run([sys.executable, str(R / "scripts/patch-qemu-egl.py"), str(runtime)], check=True)
else:
    print("NOTE: Generated runtime absent; the next build will patch it.")

# B. Worker-side WebGL readback smoke test and HMP info-block verification.
w = "web/qemu-wasm/worker.js"
if "function probeWorkerWebGL()" not in get(w):
    sub(w, "async function openStorage() {\n", r"""function probeWorkerWebGL() {
  if (typeof OffscreenCanvas !== 'function') return {ok: false, detail: 'OffscreenCanvas unavailable in worker.'};
  try {
    const probe = new OffscreenCanvas(4, 4);
    const gl = probe.getContext('webgl', {alpha: false, antialias: false});
    if (!gl) return {ok: false, detail: 'Worker WebGL 1 context creation failed.'};
    gl.disable(gl.DITHER);
    gl.viewport(0, 0, 4, 4);
    gl.clearColor(0.25, 0.5, 0.75, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.finish();
    const pixel = new Uint8Array(4);
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const expected = [64, 128, 191, 255];
    const ok = expected.every((v, i) => Math.abs(pixel[i] - v) <= 4);
    const version = String(gl.getParameter(gl.VERSION) || 'WebGL 1');
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return {
      ok,
      version,
      detail: ok ? `Worker WebGL pixel readback passed (${version}).`
                 : `WebGL pixel readback mismatch: ${Array.from(pixel).join(',')}`,
    };
  } catch (e) {
    return {ok: false, detail: `Worker WebGL test failed: ${e.message}`};
  }
}

async function openStorage() {
""", "worker WebGL pixel preflight")

if "let blockInfoPending = false;" not in get(w):
    sub(w, "let monitorOutput = '';\n",
        "let monitorOutput = '';\nlet blockInfoPending = false;\nlet blockInfoOutput = '';\nlet blockInfoTimer = null;\n",
        "block verification state")

if "function requestBlockInfo()" not in get(w):
    sub(w, "function onMonitorData(bytes, acknowledge) {\n", r"""function requestBlockInfo() {
  if (blockInfoPending || !writeToPty) return;
  blockInfoPending = true;
  blockInfoOutput = '';
  writeToPty('info block\r');
  blockInfoTimer = setTimeout(() => {
    if (!blockInfoPending) return;
    blockInfoPending = false;
    post('block-devices', {
      isoAttached: blockInfoOutput.includes('/opfs/android-x86.iso'),
      diskAttached: blockInfoOutput.includes('/opfs/android-data.raw'),
      timedOut: true,
      detail: blockInfoOutput.slice(-4000),
    });
  }, 8000);
}

function onMonitorData(bytes, acknowledge) {
""", "QEMU info block request")

old_monitor = r"""  monitorOutput = (monitorOutput + text).slice(-16000);
  post('monitor-output', {data: text});
  if (!ready && monitorOutput.includes('(qemu)')) {
    ready = true;
    post('ready', {
      machine: 'pc (i440FX/PIIX IDE)',
      devices: 'read-only IDE CD-ROM + writable raw IDE disk',
    });
    if (stopRequested) writeToPty('quit\r');
  }
"""
new_monitor = r"""  monitorOutput = (monitorOutput + text).slice(-16000);
  post('monitor-output', {data: text});
  if (blockInfoPending) {
    blockInfoOutput = (blockInfoOutput + text).slice(-8000);
    if (blockInfoOutput.includes('(qemu)')) {
      blockInfoPending = false;
      if (blockInfoTimer) clearTimeout(blockInfoTimer);
      blockInfoTimer = null;
      post('block-devices', {
        isoAttached: blockInfoOutput.includes('/opfs/android-x86.iso'),
        diskAttached: blockInfoOutput.includes('/opfs/android-data.raw'),
        timedOut: false,
        detail: blockInfoOutput.slice(-4000),
      });
    }
  }
  if (!ready && monitorOutput.includes('(qemu)')) {
    ready = true;
    post('ready', {
      machine: 'pc (i440FX/PIIX IDE)',
      devices: 'Monitor prompt received; checking block devices with info block.',
    });
    requestBlockInfo();
    if (stopRequested) writeToPty('quit\r');
  }
"""
sub(w, old_monitor, new_monitor, "monitor prompt triggers actual block-device verification")
sub(w, "  if (serialTimer) clearInterval(serialTimer);\n  flushSerial();\n",
    "  if (serialTimer) clearInterval(serialTimer);\n  if (blockInfoTimer) clearTimeout(blockInfoTimer);\n  blockInfoTimer = null;\n  blockInfoPending = false;\n  flushSerial();\n",
    "clear block-check timer on QEMU exit")
sub(w,
    "    if (!message.canvas) throw new Error('The QEMU display canvas was not transferred to the worker.');\n"
    "    if (typeof SharedArrayBuffer === 'undefined') {\n",
    "    if (!message.canvas) throw new Error('The QEMU display canvas was not transferred to the worker.');\n"
    "    const graphics = probeWorkerWebGL();\n"
    "    post('graphics-preflight', graphics);\n"
    "    if (!graphics.ok) throw new Error(graphics.detail);\n"
    "    if (typeof SharedArrayBuffer === 'undefined') {\n",
    "run worker WebGL smoke test before QEMU starts")

# C. Browser app: static hosts do not have /api/status; use relative URLs.
a = "web/app.js"
sub(a, "let wasmReady = false;\nlet wasmEverStarted = false;\n",
    "let wasmReady = false; // QEMU monitor ready; not proof of Android boot.\n"
    "let wasmEverStarted = false;\n"
    "let wasmIsoAttached = false;\nlet wasmDiskAttached = false;\nlet wasmBlockInfoReceived = false;\n"
    "let wasmGraphicsPreflight = null;\nlet wasmCanvasTransferred = false;\nlet wasmGuestBootObserved = false;\n",
    "separate runtime, graphics, devices, and guest states")
sub(a, "const response = await fetch('/qemu-wasm/manifest.json', {cache: 'no-store'});",
    "const response = await fetch(new URL('qemu-wasm/manifest.json', document.baseURI), {cache: 'no-store'});",
    "relative manifest URL")
sub(a, "    const status = await api('/api/status');\n", """    let status;
    try {
      status = await api('/api/status');
    } catch (error) {
      // Static sites do not expose the optional Codespaces native-QEMU API.
      // Browser QEMU-WASM and OPFS must remain usable without that backend.
      status = {
        api_available: false,
        qemu: {installed: false, version: null, running: false, pid: null},
        qemu_img: {installed: false, version: null},
        novnc: {installed: false, web_root: null, proxy_running: false},
        qemu_tail: '', serial_tail: '', last_error: '',
      };
    }
""", "static-host-safe refresh")

old_attach = """    $('diskAttachedStatus').textContent = wasmReady
      ? 'Yes — writable OPFS block device attached to QEMU-WASM'
      : 'No — start QEMU-WASM after the ISO and disk are ready';
"""
new_attach = """    $('diskAttachedStatus').textContent = !wasmWorker
      ? 'No — QEMU-WASM is not running'
      : !wasmReady
        ? 'Waiting for the QEMU monitor'
        : !wasmBlockInfoReceived
          ? 'Monitor ready; checking info block…'
          : wasmDiskAttached
            ? 'Confirmed by QEMU info block'
            : 'Not confirmed by QEMU info block';
    $('graphicsStatus').textContent = wasmGraphicsPreflight === null
      ? 'Not run'
      : wasmGraphicsPreflight ? 'PASS — worker WebGL test' : 'FAIL — see QEMU output';
    $('monitorStatus').textContent = wasmReady ? 'Monitor prompt received' : wasmWorker ? 'Starting…' : 'Not started';
    $('isoAttachedStatus').textContent = wasmBlockInfoReceived
      ? wasmIsoAttached ? 'Confirmed by QEMU info block' : 'Not confirmed by QEMU info block'
      : 'Not verified';
    $('diskDeviceStatus').textContent = wasmBlockInfoReceived
      ? wasmDiskAttached ? 'Confirmed by QEMU info block' : 'Not confirmed by QEMU info block'
      : 'Not verified';
    $('canvasStatus').textContent = wasmCanvasTransferred
      ? 'Transferred to worker; guest frame not yet verified'
      : 'Not transferred';
    $('guestBootStatus').textContent = wasmGuestBootObserved
      ? 'Early Linux/Android serial marker seen; UI readiness not proven'
      : 'Not observed in serial output';
"""
sub(a, old_attach, new_attach, "evidence-based disk/graphics/guest status")
sub(a, "      ? wasmReady ? 'QEMU-WASM running' : 'QEMU-WASM starting'\n",
    "      ? wasmReady ? 'QEMU-WASM monitor ready' : 'QEMU-WASM starting'\n",
    "do not call monitor readiness VM running")
sub(a,
    "    $('serialLog').scrollTop = $('serialLog').scrollHeight;\n  } else {\n",
    r"""    $('serialLog').scrollTop = $('serialLog').scrollHeight;
    if (/\bLinux version\b|\bBooting the Linux kernel\b|\bAndroid-x86\b|\bzygote\b|\bSystemServer\b/i.test(text)) {
      wasmGuestBootObserved = true;
      $('guestBootStatus').textContent = 'Early Linux/Android serial marker seen; UI readiness not proven';
    }
  } else {
""",
    "observe guest serial markers carefully")

old_handler = """  if (message.type === 'status') setMessage('vmMessage', message.message);
  if (message.type === 'ready') {
    wasmReady = true;
    wasmEverStarted = true;
    setMessage('vmMessage', `QEMU-WASM initialized · ${message.machine} · ${message.devices}`);
"""
new_handler = r"""  if (message.type === 'status') setMessage('vmMessage', message.message);
  if (message.type === 'graphics-preflight') {
    wasmGraphicsPreflight = Boolean(message.ok);
    $('graphicsStatus').textContent = message.ok ? `PASS — ${message.detail}` : `FAIL — ${message.detail}`;
  }
  if (message.type === 'block-devices') {
    wasmBlockInfoReceived = true;
    wasmIsoAttached = Boolean(message.isoAttached);
    wasmDiskAttached = Boolean(message.diskAttached);
    const summary = `QEMU info block: ISO ${wasmIsoAttached ? 'confirmed' : 'NOT confirmed'}; disk ${wasmDiskAttached ? 'confirmed' : 'NOT confirmed'}.`;
    setMessage('vmMessage', summary, !(wasmIsoAttached && wasmDiskAttached));
    if (message.detail) appendWasmLog('monitor', `\n[info block verification]\n${message.detail}`);
    void refresh();
  }
  if (message.type === 'ready') {
    wasmReady = true;
    wasmEverStarted = true;
    setMessage('vmMessage', 'QEMU monitor ready; checking ISO and disk with info block…');
"""
sub(a, old_handler, new_handler, "process graphics and block-device verification events")
sub(a,
    "    wasmReady = false;\n    wasmEverStarted = true;\n    wasmWorker = null;\n    wasmMonitorBuffer = null;\n",
    "    wasmReady = false;\n    wasmEverStarted = true;\n    wasmWorker = null;\n    wasmMonitorBuffer = null;\n"
    "    wasmIsoAttached = false;\n    wasmDiskAttached = false;\n    wasmBlockInfoReceived = false;\n    wasmCanvasTransferred = false;\n",
    "reset session states after stop")
sub(a,
    "  wasmMonitorLog = '';\n  wasmSerialLog = '';\n  wasmReady = false;\n  wasmEverStarted = true;\n",
    "  wasmMonitorLog = '';\n  wasmSerialLog = '';\n  wasmReady = false;\n"
    "  wasmIsoAttached = false;\n  wasmDiskAttached = false;\n  wasmBlockInfoReceived = false;\n"
    "  wasmGraphicsPreflight = null;\n  wasmCanvasTransferred = false;\n  wasmGuestBootObserved = false;\n"
    "  wasmEverStarted = true;\n",
    "reset session verification before start")
sub(a, "  const worker = new Worker('/qemu-wasm/worker.js');",
    "  const workerUrl = new URL('qemu-wasm/worker.js', document.baseURI);\n  const worker = new Worker(workerUrl);",
    "relative worker URL")
sub(a,
    "  worker.postMessage({type: 'start', mode, canvas: offscreen, monitorBuffer: wasmMonitorBuffer}, [offscreen]);\n",
    "  wasmCanvasTransferred = true;\n"
    "  $('canvasStatus').textContent = 'Transferred to worker; guest frame not yet verified';\n"
    "  worker.postMessage({type: 'start', mode, canvas: offscreen, monitorBuffer: wasmMonitorBuffer}, [offscreen]);\n",
    "distinguish canvas transfer from a rendered frame")

# D. Relative HTML assets and explicit runtime diagnostics.
h = "web/index.html"
sub(h, "<title>Android in Browser — Boot Console</title>", "<title>WASMdroid — Android in Browser</title>", "WASMdroid title")
sub(h, 'href="/style.css"', 'href="./style.css"', "relative stylesheet")
sub(h, '<h1>Android boot console</h1>', '<h1>WASMdroid</h1>', "WASMdroid heading")
diag = ('<div class="grid"><div><label>QEMU output</label><pre id="qemuLog">No log yet.</pre></div>'
        '<div><label>Serial output</label><pre id="serialLog">No serial bytes yet.</pre></div></div>')
diag_new = diag + """
    <div class="disk-status">
      <div><b>Worker WebGL test</b><span id="graphicsStatus">Not run</span></div>
      <div><b>QEMU monitor</b><span id="monitorStatus">Not started</span></div>
      <div><b>ISO attached</b><span id="isoAttachedStatus">Not verified</span></div>
      <div><b>Disk attached</b><span id="diskDeviceStatus">Not verified</span></div>
      <div><b>QEMU canvas</b><span id="canvasStatus">Not transferred</span></div>
      <div><b>Guest boot</b><span id="guestBootStatus">Not observed</span></div>
    </div>
"""
sub(h, diag, diag_new, "add honest graphics and boot diagnostics")
sub(h, 'src="/app.js"', 'src="./app.js"', "relative app script")
sub(h, "Android Browser Boot • user-supplied Android-x86 ISO • no Google proprietary components included",
    "WASMdroid • user-supplied Android-x86 ISO • no Google proprietary components included", "WASMdroid footer")

# The headers file must live inside web/, which is the static output directory.
put("web/_headers", """/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
""")
put("STATIC_DEPLOYMENT.md", """# WASMdroid static deployment

Publish the repository's `web/` directory as the static site's output directory.
It contains `index.html`, relative asset URLs, and `web/_headers`.

The `_headers` file requires the host to return:
- `Cross-Origin-Opener-Policy: same-origin`
- `Cross-Origin-Embedder-Policy: require-corp`

These headers enable `crossOriginIsolated` and `SharedArrayBuffer`, required by
the pthread-enabled QEMU-WASM build. Cloudflare Pages and Netlify support a
`_headers` file. GitHub Pages ignores `_headers` and will not satisfy this
requirement; use a static host that supports custom response headers.

The UI reports worker WebGL preflight, QEMU monitor readiness, HMP `info block`
device checks, and early serial boot markers separately. Canvas transfer is
not reported as a rendered Android frame. A monitor prompt or WebGL preflight
does not prove Android has booted.

The optional native Codespaces QEMU/noVNC fallback is separate and cannot read
browser OPFS files. Browser QEMU-WASM does not require `/api/status`.
""")
put("README.md", """# WASMdroid

Android-x86 in the browser using QEMU-WASM and browser-local OPFS storage.

The intended runtime is the browser: the Android ISO is read-only in OPFS, a
separate raw writable virtual disk is stored in OPFS, and QEMU-WASM runs in a
worker. The native QEMU/noVNC path is only an optional Codespaces fallback; it
cannot access browser OPFS files.

See [README_START_HERE.md](README_START_HERE.md) for development instructions
and [STATIC_DEPLOYMENT.md](STATIC_DEPLOYMENT.md) for static-host requirements.
Publish `web/` on a host that honors its `_headers` file. GitHub Pages ignores
`_headers` and does not satisfy the SharedArrayBuffer requirement.
""")

quick = R / "README_START_HERE.md"
if quick.is_file():
    s = quick.read_text(encoding="utf-8")
    note = ("\n\n## Static deployment note\n\n"
            "Publish `web/` using a host that honors `web/_headers` (COOP/COEP). "
            "GitHub Pages ignores `_headers`, so it does not satisfy the "
            "SharedArrayBuffer requirement. See [STATIC_DEPLOYMENT.md]"
            "(STATIC_DEPLOYMENT.md).\n")
    if "## Static deployment note" not in s:
        put("README_START_HERE.md", s.rstrip() + note)

print("File edits applied.")
PY

echo
echo "Running syntax and diff checks..."
bash -n "$ROOT/BUILD_QEMU_WASM.sh"
echo "PASS: build script syntax"
if command -v node >/dev/null 2>&1; then
  node --check "$ROOT/web/app.js"
  node --check "$ROOT/web/qemu-wasm/worker.js"
  echo "PASS: browser JavaScript syntax"
else
  echo "SKIP: Node.js not installed; JS syntax not checked"
fi
python3 -m py_compile "$ROOT/scripts/patch-qemu-egl.py"
echo "PASS: EGL patcher syntax"
if [[ -f "$ROOT/web/qemu-wasm/qemu-system-x86_64.js" ]]; then
  python3 "$ROOT/scripts/patch-qemu-egl.py" "$ROOT/web/qemu-wasm/qemu-system-x86_64.js"
fi
git -C "$ROOT" diff --check
echo "PASS: git diff --check"
echo
git -C "$ROOT" status --short
echo
echo "DONE. Backup: $BACKUP"
echo "No QEMU build, Android boot, OPFS access/reset, commit, or push was performed."
echo "Review the diff, then commit and push from Codespaces."
