#!/usr/bin/env bash
set -Eeuo pipefail
fail=0
check() { if command -v "$1" >/dev/null 2>&1; then printf 'PASS %-22s %s\n' "$1" "$(command -v "$1")"; else printf 'FAIL %-22s missing\n' "$1"; fail=1; fi; }
check python3
check qemu-system-x86_64
check qemu-img
check websockify
if command -v qemu-system-x86_64 >/dev/null 2>&1; then
  if qemu-system-x86_64 -help 2>&1 | grep -q -- '-vnc'; then echo 'PASS QEMU VNC option'; else echo 'FAIL QEMU VNC option unavailable'; fail=1; fi
fi
if [[ -f /usr/share/novnc/vnc.html || -f /usr/share/novnc/index.html || -f /snap/novnc/current/vnc.html ]]; then
  echo 'PASS noVNC web assets'
else
  echo 'FAIL noVNC web assets missing'; fail=1
fi
python3 - <<'PY'
import shutil
u=shutil.disk_usage('.')
print(f"Disk free: {u.free/1024**3:.1f} GiB")
try:
    mem={}
    for line in open('/proc/meminfo'):
        if ':' in line:
            k,v=line.split(':',1); mem[k]=v.strip()
    print('Memory available:',mem.get('MemAvailable','unknown'))
except OSError:
    print('Memory available: unknown')
PY
if [[ "$fail" -ne 0 ]]; then
  echo 'Run ./INSTALL.sh, then repeat ./CHECK_ENV.sh.'
  exit 1
fi
echo 'Environment checks passed.'
