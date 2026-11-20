# Android in Browser — ISO storage and QEMU fallback

The web page saves a user-selected Android-x86 ISO in the browser's Origin
Private File System (OPFS). File bytes are streamed locally in chunks; they
are not uploaded to the Codespace or passed through nginx or the forwarded-port
proxy.

The page also creates and reuses a separate 8 GiB raw virtual disk in OPFS
after checking the browser's reported quota. QEMU-WASM runs in a browser worker;
the ISO is read in chunks from OPFS as a read-only CD-ROM, and the raw disk uses
random-access OPFS reads/writes. The native QEMU/noVNC fallback remains
separate and cannot access browser OPFS.

## Start the control page

From this folder in the Codespaces terminal:

```bash
chmod +x START.sh INSTALL.sh STOP.sh
./START.sh
```

Open port 8000 in Codespaces. The page requires a browser with OPFS support over
a secure context (Codespaces HTTPS or localhost).

## Save an ISO locally in the browser

1. Select `android-x86_64-9.0-r2.iso`.
2. Click **Save ISO in this browser**.
3. Follow the streaming progress. The page verifies that the OPFS file size
   matches the selected file and reports the name and size.

The file persists across refreshes where browser storage permits. Browser
storage may be evicted unless the browser grants persistent storage. Clear
browser storage only if you intend to remove the saved ISO.

## Virtual disk

On page load, the app checks `navigator.storage.estimate()` and creates a
separate 8 GiB raw disk in OPFS only if the reported available quota is
sufficient. It uses file truncation rather than allocating an 8 GiB JavaScript
buffer. Existing 8 GiB disks are reused. The **Create / reset virtual disk**
button requires confirmation before deleting an existing disk.

The interface reports disk presence, runtime readiness, attachment, capacity,
and storage errors. Attachment is reported only after QEMU-WASM reaches its
monitor prompt.

## Build and start QEMU-WASM

Build the pinned browser runtime from the Codespace terminal:

```bash
./BUILD_QEMU_WASM.sh
```

The script builds QEMU-WASM commit
`0ef7b4e2814b231705d8371dd7997f5b72e70baf` (QEMU 8.2.0) with SDL2,
OffscreenCanvas, and the x86_64 system target. It creates `web/qemu-wasm/manifest.json`
only after the browser assets have been copied. The build requires Docker and
network access for the pinned DTC Meson subproject.

Start `./START.sh`, save an Android-x86 ISO, and wait for the environment check
to report the runtime and both OPFS files ready. **Start from browser ISO** boots
the Android installer/live system; install to the OPFS disk before choosing
**Boot installed Android from disk**. The emulator uses the QEMU `pc`
(i440FX/PIIX IDE) machine with an IDE CD-ROM (`readonly=on`) and a raw IDE disk.
The ISO is accessed through chunked worker reads; disk I/O uses OPFS
`FileSystemSyncAccessHandle` and is flushed on clean QEMU shutdown.

The monitor field accepts QEMU HMP commands such as `info block`. The UI does
not claim Android boot completion based on process startup alone; inspect the
emulated display and monitor output.

## Dependencies and defaults

- Debian/Ubuntu-based GitHub Codespaces.
- `qemu-system-x86_64`, `qemu-img`, `novnc`, `websockify`, Python 3.
- Native fallback uses software CPU emulation (TCG), 3072 MiB RAM, 2 CPUs, and
  a 16 GB virtual disk by default.

Override native fallback settings before starting:

```bash
ANDROID_RAM_MB=4096 ANDROID_CPUS=2 ANDROID_DISK_SIZE=24G ./START.sh
```

See [docs/BOOT_FLOW.md](./docs/BOOT_FLOW.md) for what is implemented and what
still needs verification.

## Static deployment note

Publish `web/` using a host that honors `web/_headers` (COOP/COEP). GitHub Pages ignores `_headers`, so it does not satisfy the SharedArrayBuffer requirement. See [STATIC_DEPLOYMENT.md](STATIC_DEPLOYMENT.md).
