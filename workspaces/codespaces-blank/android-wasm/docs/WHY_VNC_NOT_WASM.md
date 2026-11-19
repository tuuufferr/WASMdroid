# QEMU-WASM status and native fallback

The experimental QEMU-WASM fork is a patched QEMU port for browsers. This
package now contains a pinned x86_64 build path, a worker-based SDL display,
and an OPFS-backed file bridge. The ISO is read in chunks from a browser `File`
object; the raw disk uses synchronous OPFS random-access I/O.

Build the runtime with `./BUILD_QEMU_WASM.sh`. The monitor prompt and
`info block` output are the indicators that QEMU has started and parsed its
block devices. The existence of build files or enabled UI controls is not
evidence that Android booted.

The native QEMU fallback remains for an already-installed virtual disk. It
runs inside the Codespace and streams the display to the browser with VNC and
noVNC; it cannot access browser OPFS.

Do not describe ISO boot as working until the actual ISO is loaded from OPFS
by QEMU-WASM and the guest boot is verified in the browser.
