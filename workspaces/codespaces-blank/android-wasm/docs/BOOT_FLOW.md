# Browser storage and boot status

## Browser-local devices

The Android ISO is stored separately from the writable virtual hard disk:

```text
Browser file picker
   | chunked writes
   v
OPFS/android-iso/android-x86.iso           (read-only CD-ROM source)

OPFS/android-disk/android-data.raw          (8 GiB raw writable-disk image)
```

The disk is created automatically only after `navigator.storage.estimate()`
reports enough available quota. Creation uses OPFS file truncation and does
not allocate a disk-sized JavaScript buffer. An existing correctly sized disk
is reused; an existing disk is deleted only after confirmation through the
reset button. Disk creation and ISO storage happen in browser storage, not on
the Codespace server.

The UI reports the disk's presence, OPFS capacity, attachment status, and
storage errors. **Created does not mean attached.** `BUILD_QEMU_WASM.sh` builds
the pinned QEMU-WASM x86_64 system target. The app starts it in a dedicated
browser worker and adds two Emscripten file nodes: a read-only ISO node backed
by synchronous, sliced `File` reads, and a writable raw-disk node backed by an
OPFS `FileSystemSyncAccessHandle`. QEMU uses the `pc` machine's PIIX IDE
controller with `ide-cd` and `ide-hd`; native Codespace QEMU is not used for
these browser-local files.

## QEMU-WASM acceptance checks

The implementation is present, but code paths alone do not prove a successful
attachment or boot. Verify in a real browser before reporting completion:

1. Load the existing ISO and confirm the OPFS file's size.
2. Use QEMU monitor `info block` to confirm the ISO is a read-only CD-ROM and
   the raw disk is writable.
3. Use QEMU monitor `qemu-io` commands, where available, to read ISO sectors,
   write/read a disk-sector marker, and re-read it after a clean restart.
4. Start from the ISO and observe the Android bootloader/kernel and userspace
   on the QEMU-WASM display.

Until those checks have passed, do not claim Android boot, guest sector I/O, or
restart persistence.

## Separate native fallback

The existing native fallback remains a separate installed-disk path. It
cannot access the ISO or virtual disk in browser OPFS. Its VNC service must
remain bound to loopback port 5901; keep forwarded ports 8000 and 6080 private.
