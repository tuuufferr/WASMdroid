#!/usr/bin/env bash
set -Eeuo pipefail
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer currently targets Debian/Ubuntu-based Codespaces."
  echo "Install qemu-system-x86, qemu-utils, novnc and websockify with your distribution's package manager."
  exit 2
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils novnc websockify ca-certificates python3

command -v qemu-system-x86_64 >/dev/null
a=$(command -v qemu-img)
b=$(command -v websockify)
echo "Installed QEMU: $(qemu-system-x86_64 --version | head -n 1)"
echo "qemu-img: $a"
echo "websockify: $b"
if [[ -f /usr/share/novnc/vnc.html ]]; then
  echo "noVNC UI: /usr/share/novnc/vnc.html"
elif [[ -f /usr/share/novnc/index.html ]]; then
  echo "noVNC UI: /usr/share/novnc/index.html"
else
  echo "WARNING: noVNC web root not found at /usr/share/novnc; server will search common locations."
fi
