# Dependencies and current boot support

## Native fallback dependencies

`INSTALL.sh` installs these Debian/Ubuntu packages for the native installed-disk
fallback:

| Package | Purpose |
|---|---|
| `qemu-system-x86` | Native x86_64 machine emulator and virtual devices |
| `qemu-utils` | `qemu-img` to create the qcow2 virtual disk |
| `novnc` | Browser client assets |
| `websockify` | WebSocket-to-VNC proxy |
| `python3` | Local control and status API |
| `ca-certificates` | TLS roots for package installation |

## Start the control page

```bash
./START.sh
```

The script checks/install dependencies, starts the control service, and starts
the noVNC proxy. Open port 8000 and keep it Private.

## ISO and QEMU-WASM status

The page uses the browser File API and chunked OPFS writes to save the selected
ISO locally. It verifies the byte size and does not send the ISO to the
Codespace. It also checks browser quota and creates a separate 8 GiB raw
virtual disk in OPFS. Existing disks are reused; reset requires confirmation.

Build the pinned browser runtime with `./BUILD_QEMU_WASM.sh`. The browser
worker accesses the existing OPFS ISO in chunks and the disk through a
`FileSystemSyncAccessHandle`; QEMU attaches them to the PC machine's PIIX IDE
controller as a read-only CD-ROM and writable raw disk. The native fallback
cannot access browser OPFS and is not used for these devices.

Start from the ISO to open the Android installer/live system. Use the QEMU
monitor's `info block` output to check device attachment and use the display to
verify guest boot. Installation and persistence are not considered verified
until the disk data is read back after a clean emulator restart. See
[BOOT_FLOW.md](./BOOT_FLOW.md) for the acceptance checks.
