# WASMdroid

Android-x86 in the browser using QEMU-WASM and browser-local OPFS storage.

The intended runtime is the browser: the Android ISO is read-only in OPFS, a
separate raw writable virtual disk is stored in OPFS, and QEMU-WASM runs in a
worker. The native QEMU/noVNC path is only an optional Codespaces fallback; it
cannot access browser OPFS files.

See [README_START_HERE.md](README_START_HERE.md) for development instructions
and [STATIC_DEPLOYMENT.md](STATIC_DEPLOYMENT.md) for static-host requirements.
Publish `web/` on a host that honors its `_headers` file. GitHub Pages ignores
`_headers` and does not satisfy the SharedArrayBuffer requirement.
