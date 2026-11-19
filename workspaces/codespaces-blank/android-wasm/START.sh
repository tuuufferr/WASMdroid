#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

if [[ $# -ge 1 ]]; then
  echo "ERROR: This server no longer accepts ISO paths. Select an ISO in the browser to save it to OPFS."
  exit 1
fi

need_install=0
for cmd in qemu-system-x86_64 qemu-img websockify; do
  command -v "$cmd" >/dev/null 2>&1 || need_install=1
done
if [[ ! -f /usr/share/novnc/vnc.html && ! -f /usr/share/novnc/index.html && ! -f /snap/novnc/current/vnc.html ]]; then
  need_install=1
fi

if [[ "$need_install" -eq 1 ]]; then
  echo "Installing QEMU, qemu-img, noVNC and websockify..."
  if [[ "${EUID}" -eq 0 ]]; then
    bash "$ROOT/INSTALL.sh"
  elif command -v sudo >/dev/null 2>&1; then
    sudo -E bash "$ROOT/INSTALL.sh"
  else
    echo "ERROR: Missing dependencies and sudo is unavailable. Run ./INSTALL.sh as an administrator."
    exit 1
  fi
fi

mkdir -p "$ROOT/disks" "$ROOT/logs" "$ROOT/run"
export ANDROID_BOOT_ROOT="$ROOT"
export ANDROID_BOOT_HOST="${ANDROID_BOOT_HOST:-0.0.0.0}"
export ANDROID_BOOT_PORT="${ANDROID_BOOT_PORT:-8000}"
export ANDROID_VNC_HOST="${ANDROID_VNC_HOST:-0.0.0.0}"
export ANDROID_VNC_PORT="${ANDROID_VNC_PORT:-6080}"
export ANDROID_VNC_TARGET="${ANDROID_VNC_TARGET:-127.0.0.1:5901}"
export ANDROID_RAM_MB="${ANDROID_RAM_MB:-3072}"
export ANDROID_CPUS="${ANDROID_CPUS:-2}"
export ANDROID_DISK_SIZE="${ANDROID_DISK_SIZE:-16G}"

exec python3 "$ROOT/server.py"
