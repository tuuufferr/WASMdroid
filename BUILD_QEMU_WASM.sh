#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
QEMU_DIR="$ROOT/vendor/qemu-wasm"
OUTPUT="$ROOT/web/qemu-wasm"
IMAGE="android-qemu-wasm-build"
CONTAINER="android-qemu-wasm-build-$$"
EXPECTED_REVISION="0ef7b4e2814b231705d8371dd7997f5b72e70baf"
EXTRA_CFLAGS="-O3 -g -Wno-error=unused-command-line-argument -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE -sASYNCIFY=1 -pthread -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH -sTOTAL_MEMORY=2300MB -sWASM_BIGINT -sMALLOC=mimalloc --js-library=/build/node_modules/xterm-pty/emscripten-pty.js -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js -sUSE_SDL=2 -sOFFSCREENCANVAS_SUPPORT=1"

actual_revision="$(git -C "$QEMU_DIR" rev-parse HEAD)"
if [[ "$actual_revision" != "$EXPECTED_REVISION" ]]; then
  echo "QEMU-WASM source revision mismatch: expected $EXPECTED_REVISION, found $actual_revision" >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  temp_context="$(mktemp -d)"
  sed 's#https://zlib.net/zlib-$ZLIB_VERSION.tar.xz#https://github.com/madler/zlib/releases/download/v$ZLIB_VERSION/zlib-$ZLIB_VERSION.tar.xz#' \
    "$QEMU_DIR/Dockerfile" > "$temp_context/Dockerfile"
  if ! docker build -t "$IMAGE" "$temp_context"; then
    rm -f "$temp_context/Dockerfile"
    rmdir "$temp_context"
    exit 1
  fi
  rm -f "$temp_context/Dockerfile"
  rmdir "$temp_context"
fi

mkdir -p "$OUTPUT"
rm -f "$OUTPUT/manifest.json"
docker run -d --name "$CONTAINER" -v "$QEMU_DIR:/qemu" "$IMAGE" sleep infinity >/dev/null
cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker exec -e SDL2_CONFIG=/emsdk/upstream/emscripten/system/bin/sdl2-config \
  -e "EXTRA_CFLAGS=$EXTRA_CFLAGS" "$CONTAINER" bash -lc '
    mkdir -p /build/qemu
    cd /build/qemu
    emconfigure /qemu/configure \
      --static --target-list=x86_64-softmmu --cpu=wasm32 --cross-prefix= \
      --without-default-features --enable-system --with-coroutine=fiber \
      --enable-virtfs --enable-sdl --enable-pixman --enable-fdt=internal \
      --extra-cflags="$EXTRA_CFLAGS" --extra-cxxflags="$EXTRA_CFLAGS" \
      --extra-ldflags="-sEMULATE_FUNCTION_POINTER_CASTS=1 -sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS"
    emmake make -j2 qemu-system-x86_64
    mkdir -p /pack
    cp /qemu/pc-bios/{bios-256k.bin,vgabios-stdvga.bin,kvmvapic.bin,linuxboot_dma.bin} /pack/
    /emsdk/upstream/emscripten/tools/file_packager.py \
      qemu-system-x86_64.data --preload /pack > load.js
  '

docker cp "$CONTAINER:/build/qemu/qemu-system-x86_64" "$OUTPUT/qemu-system-x86_64.js"
docker cp "$CONTAINER:/build/qemu/qemu-system-x86_64.wasm" "$OUTPUT/"
docker cp "$CONTAINER:/build/qemu/qemu-system-x86_64.worker.js" "$OUTPUT/"
docker cp "$CONTAINER:/build/qemu/qemu-system-x86_64.data" "$OUTPUT/"
docker cp "$CONTAINER:/build/qemu/load.js" "$OUTPUT/"
docker cp "$CONTAINER:/build/node_modules/xterm-pty/index.js" "$OUTPUT/pty.js"
docker cp "$CONTAINER:/build/node_modules/xterm-pty/LICENSE.txt" "$OUTPUT/NOTICE-xterm-pty.txt"

# Keep EGL calls on the pthread that owns the transferred OffscreenCanvas.
python3 "$ROOT/scripts/patch-qemu-egl.py" "$OUTPUT/qemu-system-x86_64.js"

printf '{\n  "target": "x86_64-softmmu",\n  "qemuVersion": "8.2.0",\n  "sourceRevision": "%s",\n  "machine": "pc (i440FX/PIIX IDE)",\n  "isoDevice": "ide-cd, read-only",\n  "diskDevice": "ide-hd, raw and writable",\n  "display": "SDL2 with OffscreenCanvas"\n}\n' "$EXPECTED_REVISION" > "$OUTPUT/manifest.json"
echo "QEMU-WASM runtime built in $OUTPUT"
