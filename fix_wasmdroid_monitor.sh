#!/usr/bin/env bash
# WASMdroid monitor/PTY repair.
# Run from anywhere inside the WASMdroid Git checkout:
#   bash fix_wasmdroid_monitor.sh
set -Eeuo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
if [[ ! -f "$ROOT/web/app.js" || ! -f "$ROOT/web/qemu-wasm/worker.js" ]]; then
  echo "ERROR: Could not find web/app.js and web/qemu-wasm/worker.js."
  echo "Run this from inside the WASMdroid repository."
  exit 2
fi

BACKUP="${TMPDIR:-/tmp}/wasmdroid-monitor-backup-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP/web/qemu-wasm"
cp -p "$ROOT/web/app.js" "$BACKUP/web/app.js"
cp -p "$ROOT/web/qemu-wasm/worker.js" "$BACKUP/web/qemu-wasm/worker.js"
echo "Backup created at: $BACKUP"

python3 - "$ROOT" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
app_path = root / "web/app.js"
worker_path = root / "web/qemu-wasm/worker.js"
app = app_path.read_text(encoding="utf-8")
worker = worker_path.read_text(encoding="utf-8")

def replace_exact(source, old, new, label, expected=1):
    count = source.count(old)
    if count == 0:
        if not new or new in source:
            print(f"Already applied: {label}")
            return source
        raise SystemExit(f"PATCH FAILED: couldn't find expected source for: {label}")
    if count != expected:
        raise SystemExit(f"PATCH FAILED: {label}: expected {expected} match(es), found {count}")
    print(f"Patched: {label}")
    return source.replace(old, new)

# Frontend: remove the custom SharedArrayBuffer monitor ring. QEMU's existing
# worker PTY message path already wakes the PTY correctly.
app = replace_exact(
    app,
    "const MONITOR_HEADER_BYTES = 8;\nconst MONITOR_CAPACITY = 4096;\n",
    "",
    "remove frontend monitor ring constants",
)
app = replace_exact(
    app,
    "let wasmMonitorBuffer = null;\n",
    "",
    "remove frontend monitor ring state",
)

start_marker = "function writeWasmMonitorInput(command) {\n"
end_marker = "\nasync function refresh() {"
if start_marker in app:
    start = app.index(start_marker)
    end = app.find(end_marker, start)
    if end < 0:
        raise SystemExit("PATCH FAILED: couldn't find end of writeWasmMonitorInput().")
    app = app[:start] + app[end + 1:]
    print("Patched: remove custom frontend monitor-ring writer")
else:
    print("Already applied: remove custom frontend monitor-ring writer")

app = replace_exact(
    app,
    "    wasmMonitorBuffer = null;\n",
    "",
    "remove stopped-handler monitor buffer reset",
)
app = replace_exact(
    app,
    "  wasmMonitorBuffer = new SharedArrayBuffer(MONITOR_HEADER_BYTES + MONITOR_CAPACITY);\n",
    "",
    "remove monitor buffer allocation",
)
app = replace_exact(
    app,
    "  worker.postMessage({type: 'start', mode, canvas: offscreen, monitorBuffer: wasmMonitorBuffer}, [offscreen]);\n",
    "  worker.postMessage({type: 'start', mode, canvas: offscreen}, [offscreen]);\n",
    "start worker without custom monitor ring",
)
app = replace_exact(
    app,
    """  try {
    writeWasmMonitorInput('quit');
  } catch (error) {
    setMessage('vmMessage', error.message, true);
    return false;
  }
""",
    """  try {
    // The worker writes to the PTY master, which wakes QEMU's monitor reader.
    wasmWorker.postMessage({type: 'stop'});
  } catch (error) {
    setMessage('vmMessage', error.message, true);
    return false;
  }
""",
    "send stop through the worker PTY",
)
app = replace_exact(
    app,
    """  try {
    writeWasmMonitorInput(command);
    $('monitorCommand').value = '';
  } catch (error) {
""",
    """  try {
    // Do not write into a shared ring buffer: the worker's PTY path emits
    // the readable event QEMU is waiting for.
    wasmWorker.postMessage({type: 'monitor', command});
    $('monitorCommand').value = '';
  } catch (error) {
""",
    "send manual monitor commands through worker messages",
)
app = replace_exact(
    app,
    """    const summary = `QEMU info block: ISO ${wasmIsoAttached ? 'confirmed' : 'NOT confirmed'}; disk ${wasmDiskAttached ? 'confirmed' : 'NOT confirmed'}.`;
""",
    """    const verificationNote = message.timedOut
      ? ' (monitor response timed out after 8 seconds)'
      : message.error ? ` (${message.error})` : '';
    const summary = `QEMU info block: ISO ${wasmIsoAttached ? 'confirmed' : 'NOT confirmed'}; disk ${wasmDiskAttached ? 'confirmed' : 'NOT confirmed'}${verificationNote}.`;
""",
    "show info block timeout/error accurately",
)

# Worker: remove the matching shared-ring read override.
worker = replace_exact(
    worker,
    "const MONITOR_HEADER_BYTES = 8;\nconst MONITOR_CAPACITY = 4096;\n",
    "",
    "remove worker monitor ring constants",
)

attach_start = "function attachSharedMonitorInput(slave, buffer) {\n"
probe_start = "function probeWorkerWebGL() {"
if attach_start in worker:
    start = worker.index(attach_start)
    end = worker.find(probe_start, start)
    if end < 0:
        raise SystemExit("PATCH FAILED: couldn't find end of attachSharedMonitorInput().")
    worker = worker[:start] + worker[end:]
    print("Patched: remove custom PTY shared-ring override")
else:
    print("Already applied: remove custom PTY shared-ring override")

worker = replace_exact(
    worker,
    "    attachSharedMonitorInput(slave, message.monitorBuffer);\n",
    "",
    "remove worker shared-ring attachment",
)

# Always acknowledge monitor output before scheduling another command. This
# prevents a failed monitor write from leaving the PTY output queue stalled.
start_marker = "function requestBlockInfo() {\n"
end_marker = "function activatePty(master) {"
if start_marker in worker:
    start = worker.index(start_marker)
    end = worker.find(end_marker, start)
    if end < 0:
        raise SystemExit("PATCH FAILED: couldn't find end of monitor callback block.")
    new_block = r"""function monitorPromptAtEnd(text) {
  return /\(qemu\)\s*$/.test(String(text).trimEnd());
}

function completeBlockInfo(timedOut = false, error = '') {
  if (!blockInfoPending) return;
  blockInfoPending = false;
  if (blockInfoTimer) clearTimeout(blockInfoTimer);
  blockInfoTimer = null;
  post('block-devices', {
    isoAttached: blockInfoOutput.includes(ISO_PATH),
    diskAttached: blockInfoOutput.includes(DISK_PATH),
    timedOut,
    error,
    detail: blockInfoOutput.slice(-4000),
  });
}

function requestBlockInfo() {
  if (blockInfoPending || !writeToPty || finished) return;
  blockInfoPending = true;
  blockInfoOutput = '';

  // Start the timeout before attempting to write. A failed send must still
  // result in a visible failure instead of an infinite "checking" state.
  blockInfoTimer = setTimeout(() => {
    completeBlockInfo(true, 'QEMU did not return the info block prompt within 8 seconds.');
  }, 8000);

  // Defer until after the monitor-output callback has been acknowledged.
  setTimeout(() => {
    if (!blockInfoPending || finished) return;
    try {
      if (!writeToPty) throw new Error('The QEMU monitor PTY is unavailable.');
      writeToPty('info block\r');
    } catch (error) {
      completeBlockInfo(true, `Could not send info block: ${error.message}`);
    }
  }, 0);
}

function onMonitorData(bytes, acknowledge) {
  const text = monitorDecoder.decode(Uint8Array.from(bytes), {stream: true});
  monitorOutput = (monitorOutput + text).slice(-16000);
  post('monitor-output', {data: text});

  let blockInfoComplete = false;
  if (blockInfoPending) {
    blockInfoOutput = (blockInfoOutput + text).slice(-8000);
    blockInfoComplete = monitorPromptAtEnd(blockInfoOutput);
  }
  const firstPrompt = !ready && monitorPromptAtEnd(monitorOutput);

  // Release the PTY output queue before scheduling another monitor command.
  if (acknowledge) {
    try {
      acknowledge();
    } catch (error) {
      post('error', {message: `Could not acknowledge QEMU monitor output: ${error.message}`});
    }
  }

  if (blockInfoComplete) completeBlockInfo(false);

  if (firstPrompt) {
    ready = true;
    post('ready', {
      machine: 'pc (i440FX/PIIX IDE)',
      devices: 'Monitor prompt received; checking block devices with info block.',
    });
    if (stopRequested) {
      setTimeout(() => {
        try {
          if (writeToPty) writeToPty('quit\r');
        } catch (error) {
          post('error', {message: `Could not send QEMU quit command: ${error.message}`});
        }
      }, 0);
    } else {
      setTimeout(requestBlockInfo, 0);
    }
  }
}

"""
    worker = worker[:start] + new_block + worker[end:]
    print("Patched: acknowledge monitor output before scheduling info block")
elif "function monitorPromptAtEnd(text)" in worker:
    print("Already applied: acknowledge monitor output before scheduling info block")
else:
    raise SystemExit("PATCH FAILED: couldn't find requestBlockInfo() to replace.")

old_handler = r"""self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'start') {
    void start(message);
    return;
  }
  if (message.type === 'stop') {
    stopRequested = true;
    if (writeToPty) writeToPty('quit\r');
    return;
  }
  if (message.type === 'monitor' && ptyMaster && ready) {
    const command = String(message.command || '').trim();
    if (command && command.length <= 4096 && writeToPty) writeToPty(`${command}\r`);
  }
});"""
new_handler = r"""self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'start') {
    void start(message);
    return;
  }
  if (message.type === 'stop') {
    stopRequested = true;
    if (writeToPty && ready) {
      try {
        writeToPty('quit\r');
      } catch (error) {
        post('error', {message: `Could not send QEMU quit command: ${error.message}`});
      }
    }
    return;
  }
  if (message.type === 'monitor' && ptyMaster && ready) {
    const command = String(message.command || '').trim();
    if (!command || command.length > 4096) return;
    try {
      writeToPty(`${command}\r`);
    } catch (error) {
      post('error', {message: `Could not send QEMU monitor command: ${error.message}`});
    }
  }
});"""
worker = replace_exact(
    worker,
    old_handler,
    new_handler,
    "handle monitor and stop messages safely in worker",
)

for name, text in (("web/app.js", app), ("web/qemu-wasm/worker.js", worker)):
    stale = [token for token in ("wasmMonitorBuffer", "MONITOR_HEADER_BYTES",
                                  "MONITOR_CAPACITY", "attachSharedMonitorInput",
                                  "writeWasmMonitorInput") if token in text]
    if stale:
        raise SystemExit(f"PATCH FAILED: stale monitor-ring references in {name}: {stale}")

app_path.write_text(app, encoding="utf-8")
worker_path.write_text(worker, encoding="utf-8")
print("Wrote web/app.js and web/qemu-wasm/worker.js")
PY

echo
echo "Running JavaScript syntax checks..."
if command -v node >/dev/null 2>&1; then
  node --check "$ROOT/web/app.js"
  node --check "$ROOT/web/qemu-wasm/worker.js"
  echo "JavaScript syntax: PASS"
else
  echo "WARNING: Node.js not found; skipped node --check."
fi

echo
echo "Checking patch whitespace..."
git -C "$ROOT" diff --check

echo
echo "Changed files:"
git -C "$ROOT" status --short

echo
echo "Repair applied. Review the diff, then commit and push with:"
echo "  git add web/app.js web/qemu-wasm/worker.js"
echo "  git commit -m \"Fix WASMdroid QEMU monitor command channel\""
echo "  git push"
echo
echo "The script does not rebuild QEMU, delete the ISO, or reset the OPFS disk."
