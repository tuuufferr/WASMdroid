# Troubleshooting

## Saving an ISO in the browser fails

The browser writes the selected file to OPFS in chunks. No ISO upload request is
made to the Codespace, nginx, or the forwarded-port proxy, so the old upload
flow's HTTP 413 should no longer occur. OPFS requires browser support and a
secure context (HTTPS or localhost). If storage is unavailable or full, the
page reports the reason; free browser storage and try again. Browser storage
may still be evicted unless persistent storage is granted.

Saving the ISO does not itself boot it. Build the runtime with
`./BUILD_QEMU_WASM.sh`, then check the QEMU-WASM environment entry and the
virtual disk and ISO statuses. The native Codespace QEMU fallback cannot access
files stored in browser OPFS.

## QEMU-WASM startup or storage errors

- Open the browser developer console and read the VM status and QEMU monitor
  panes. OPFS file-open, quota, runtime-load, and device errors are surfaced
  there.
- If QEMU reports that `SharedArrayBuffer` is unavailable, open the app over
  HTTPS or localhost from `server.py` (or another server that sends
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp`). The checklist now verifies
  this requirement before enabling the QEMU-WASM start buttons. A server that
  was already running before these headers were added must be restarted. If
  using another port instead, save the ISO and create the disk again: browser
  OPFS storage is scoped to the page's origin, including its port.
- Confirm the browser supports OPFS synchronous access handles in dedicated
  workers.
- Wait for the QEMU monitor prompt before using `info block`. The UI does not
  label the devices attached before QEMU reaches that prompt.
- Stop QEMU from its monitor and wait for the worker to report that it flushed
  and closed the disk handle before restarting or resetting the disk.

## Port 6080 opens but noVNC cannot connect

- Confirm QEMU is running on the status page.
- Confirm `logs/qemu.log` contains no error about VNC binding.
- Confirm port 6080 is forwarded and private in Codespaces.
- Confirm port 5901 is not forwarded. It should remain loopback-only.

## Native fallback QEMU fails to start

Run:

```bash
qemu-system-x86_64 --version
qemu-system-x86_64 -help | grep -E -- '-vnc|-drive'
qemu-img --version
websockify --help | head
```

Then read `logs/qemu.log`. Do not change the Android ISO until QEMU's exact error is understood.

## Android boot menu appears, but live boot is black

Wait at least 90 seconds before concluding it is stuck. Reopen the console and select a debug entry if present. If testing `nomodeset`, make only that one change and record the before/after. Do not simultaneously change CPU, RAM, BIOS and VGA settings.

## Android restarts or freezes

- Inspect QEMU log and available guest screen.
- First try 4096 MiB RAM if the Codespace has enough memory.
- If the Codespace itself is memory-constrained, try 2048 MiB.
- Keep `-machine pc,accel=tcg` and standard VGA unchanged while isolating the cause.

## Network missing in Android

The package uses QEMU user networking with an emulated Intel e1000 adapter. Android-x86 may require its Ethernet setting or supported guest driver. Treat this as a separate issue after the launcher boots.
