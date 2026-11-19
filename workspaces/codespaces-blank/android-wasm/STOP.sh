#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 - "$ROOT" <<'PY'
import json, urllib.request, sys
url='http://127.0.0.1:8000/api/stop'
try:
    req=urllib.request.Request(url, data=b'{}', headers={'Content-Type':'application/json'}, method='POST')
    print(urllib.request.urlopen(req, timeout=3).read().decode())
except Exception as e:
    print('No running Android control server found:', e)
PY
