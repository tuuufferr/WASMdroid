# WASMdroid static deployment

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
