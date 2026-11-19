#!/usr/bin/env python3
"""Local control server for QEMU Android-x86 + noVNC browser display."""
from __future__ import annotations
import json
import os
import shutil
import socket
import subprocess
import threading
import time
import traceback
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(os.environ.get("ANDROID_BOOT_ROOT", Path(__file__).resolve().parent)).resolve()
WEB = ROOT / "web"
DISKS = ROOT / "disks"
LOGS = ROOT / "logs"
RUN = ROOT / "run"
DISK_PATH = DISKS / "android-data.qcow2"
QEMU_BIN = os.environ.get("QEMU_BIN", "qemu-system-x86_64")
QEMU_RAM = int(os.environ.get("ANDROID_RAM_MB", "3072"))
QEMU_CPUS = int(os.environ.get("ANDROID_CPUS", "2"))
DISK_SIZE = os.environ.get("ANDROID_DISK_SIZE", "16G")
HOST = os.environ.get("ANDROID_BOOT_HOST", "0.0.0.0")
PORT = int(os.environ.get("ANDROID_BOOT_PORT", "8000"))
VNC_HOST = os.environ.get("ANDROID_VNC_HOST", "0.0.0.0")
VNC_PORT = int(os.environ.get("ANDROID_VNC_PORT", "6080"))
VNC_TARGET = os.environ.get("ANDROID_VNC_TARGET", "127.0.0.1:5901")
for p in (DISKS, LOGS, RUN):
    p.mkdir(parents=True, exist_ok=True)

state_lock = threading.RLock()
qemu_proc: subprocess.Popen | None = None
vnc_proc: subprocess.Popen | None = None
qemu_started_at: float | None = None
qemu_mode: str | None = None
last_error: str | None = None


def find_novnc_root() -> Path | None:
    candidates = [
        Path("/usr/share/novnc"),
        Path("/usr/share/novnc/app"),
        Path("/snap/novnc/current"),
        Path("/usr/local/share/novnc"),
    ]
    for path in candidates:
        if (path / "vnc.html").is_file() or (path / "index.html").is_file():
            return path
    return None


def bind_available(host: str, port: int) -> bool:
    try:
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            s.bind((host, port))
        return True
    except OSError:
        return False


def ensure_vnc_proxy() -> None:
    global vnc_proc
    with state_lock:
        if vnc_proc is not None and vnc_proc.poll() is None:
            return
        websockify = shutil.which("websockify")
        novnc_root = find_novnc_root()
        if not websockify or not novnc_root:
            raise RuntimeError("noVNC/websockify is missing. Run ./INSTALL.sh and restart ./START.sh.")
        if not bind_available("0.0.0.0", VNC_PORT):
            # A pre-existing proxy may be from a previous server instance.
            # Do not kill it; it may be the active forwarding endpoint.
            return
        logfile = open(LOGS / "websockify.log", "ab", buffering=0)
        vnc_proc = subprocess.Popen(
            [websockify, f"--web={novnc_root}", f"{VNC_HOST}:{VNC_PORT}", VNC_TARGET],
            cwd=str(ROOT), stdout=logfile, stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        time.sleep(0.35)
        if vnc_proc.poll() is not None:
            raise RuntimeError("websockify exited during startup; see logs/websockify.log")


def tool_version(command: str) -> str | None:
    path = shutil.which(command)
    if not path:
        return None
    try:
        p = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=5)
        return (p.stdout or p.stderr).strip().splitlines()[0]
    except Exception:
        return path


def process_state() -> dict:
    global qemu_proc, qemu_started_at
    with state_lock:
        running = qemu_proc is not None and qemu_proc.poll() is None
        if not running and qemu_proc is not None:
            code = qemu_proc.returncode
            qemu_proc = None
            qemu_started_at = None
        return {
            "running": running,
            "pid": qemu_proc.pid if running and qemu_proc else None,
            "started_at": qemu_started_at,
            "mode": qemu_mode if running else None,
        }


def tail(path: Path, limit: int = 35) -> str:
    if not path.exists():
        return ""
    try:
        data = path.read_text(errors="replace").splitlines()
        return "\n".join(data[-limit:])
    except Exception as exc:
        return f"Could not read log: {exc}"


def status_payload() -> dict:
    proc = process_state()
    novnc_root = find_novnc_root()
    return {
        "ok": True,
        "qemu": {"installed": shutil.which(QEMU_BIN) is not None, "version": tool_version(QEMU_BIN), **proc},
        "qemu_img": {"installed": shutil.which("qemu-img") is not None, "version": tool_version("qemu-img")},
        "novnc": {"installed": shutil.which("websockify") is not None and novnc_root is not None,
                  "web_root": str(novnc_root) if novnc_root else None,
                  "proxy_running": vnc_proc is not None and vnc_proc.poll() is None},
        "disk": {"present": DISK_PATH.is_file(), "path": str(DISK_PATH),
                 "size": DISK_PATH.stat().st_size if DISK_PATH.is_file() else 0,
                 "virtual_size": DISK_SIZE},
        "vnc": {"host": VNC_HOST, "port": VNC_PORT, "target": VNC_TARGET},
        "settings": {"ram_mb": QEMU_RAM, "cpus": QEMU_CPUS, "disk_size": DISK_SIZE},
        "last_error": last_error,
        "serial_tail": tail(LOGS / "serial.log", 20),
        "qemu_tail": tail(LOGS / "qemu.log", 30),
    }


def start_vm(mode: str) -> dict:
    global qemu_proc, qemu_started_at, qemu_mode, last_error
    if mode != "disk":
        raise ValueError("ISO boot requires a browser QEMU-WASM runtime. This server only boots installed virtual disks.")
    with state_lock:
        if qemu_proc is not None and qemu_proc.poll() is None:
            raise RuntimeError("Android VM is already running. Stop it before starting again.")
        if shutil.which(QEMU_BIN) is None:
            raise RuntimeError("qemu-system-x86_64 is not installed. Run ./INSTALL.sh.")
        if not shutil.which("qemu-img"):
            raise RuntimeError("qemu-img is not installed. Run ./INSTALL.sh.")
        if not DISK_PATH.is_file():
            raise RuntimeError("Installed virtual disk not found. ISO boot is not available in the native Codespace fallback.")
        ensure_vnc_proxy()

        qemu_log_path = LOGS / "qemu.log"
        serial_log_path = LOGS / "serial.log"
        for p in (qemu_log_path, serial_log_path):
            p.write_text("")
        monitor_path = RUN / "qemu-monitor.sock"
        try:
            monitor_path.unlink()
        except FileNotFoundError:
            pass

        args = [
            QEMU_BIN,
            "-name", "android-x86-browser-session",
            "-machine", "pc,accel=tcg",
            "-cpu", "max",
            "-smp", str(QEMU_CPUS),
            "-m", str(QEMU_RAM),
            "-drive", f"file={DISK_PATH},if=ide,index=0,format=qcow2",
            "-boot", "order=c",
            "-vga", "std",
            "-vnc", "127.0.0.1:1",
            "-usb",
            "-device", "usb-tablet",
            "-netdev", "user,id=net0",
            "-device", "e1000,netdev=net0",
            "-rtc", "base=localtime",
            "-serial", f"file:{serial_log_path}",
            "-monitor", f"unix:{monitor_path},server,nowait",
        ]
        logfile = open(qemu_log_path, "ab", buffering=0)
        try:
            qemu_proc = subprocess.Popen(args, cwd=str(ROOT), stdout=logfile,
                                         stderr=subprocess.STDOUT, start_new_session=True)
        except Exception:
            logfile.close()
            raise
        time.sleep(0.5)
        if qemu_proc.poll() is not None:
            code = qemu_proc.returncode
            qemu_proc = None
            logfile.close()
            last_error = f"QEMU exited immediately with code {code}; see logs/qemu.log."
            raise RuntimeError(last_error)
        qemu_started_at = time.time()
        qemu_mode = mode
        last_error = None
        return {"ok": True, "pid": qemu_proc.pid, "mode": mode,
                "vnc_url_path": "/vnc.html?autoconnect=true&resize=scale"}


def stop_vm() -> dict:
    global qemu_proc, qemu_started_at, qemu_mode
    with state_lock:
        if qemu_proc is None or qemu_proc.poll() is not None:
            qemu_proc = None
            qemu_started_at = None
            qemu_mode = None
            return {"ok": True, "stopped": False, "message": "No VM was running."}
        proc = qemu_proc
        proc.terminate()
        try:
            proc.wait(timeout=8)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=4)
        qemu_proc = None
        qemu_started_at = None
        qemu_mode = None
        return {"ok": True, "stopped": True}


class Handler(BaseHTTPRequestHandler):
    server_version = "AndroidBrowserBoot/1.0"

    def log_message(self, fmt, *args):
        print("[http] " + fmt % args, flush=True)

    def _json(self, payload: dict, status: int = 200):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def send_error(self, code, message=None, explain=None):
        if urlparse(getattr(self, "path", "")).path.startswith("/api/"):
            self._json({"ok": False, "error": message or HTTPStatus(code).phrase}, code)
            return
        super().send_error(code, message, explain)

    def _body_json(self) -> dict:
        size = int(self.headers.get("Content-Length", "0"))
        if size > 1024 * 1024:
            raise ValueError("JSON request too large")
        raw = self.rfile.read(size) if size else b"{}"
        return json.loads(raw.decode("utf-8"))

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self._json({"ok": True, "service": "android-browser-boot"})
            return
        if path == "/api/status":
            self._json(status_payload())
            return
        if path == "/api/logs":
            qs = parse_qs(urlparse(self.path).query)
            kind = qs.get("kind", ["qemu"])[0]
            file = LOGS / ("serial.log" if kind == "serial" else "qemu.log")
            raw = tail(file, 300).encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if path == "/" or path == "/index.html":
            target = WEB / "index.html"
        else:
            target = WEB / path.lstrip("/")
        try:
            target = target.resolve(strict=True)
            if not target.is_relative_to(WEB.resolve()) or not target.is_file():
                raise FileNotFoundError
            raw = target.read_bytes()
        except (FileNotFoundError, PermissionError, OSError):
            self.send_error(404)
            return
        content_type = "text/html; charset=utf-8" if target.suffix == ".html" else \
                       "text/css; charset=utf-8" if target.suffix == ".css" else \
                       "application/javascript; charset=utf-8" if target.suffix in (".js", ".mjs") else \
                       "application/json; charset=utf-8" if target.suffix == ".json" else \
                       "application/wasm" if target.suffix == ".wasm" else "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        global last_error
        path = urlparse(self.path).path
        try:
            if path == "/api/start":
                body = self._body_json()
                mode = body.get("mode", "disk")
                self._json(start_vm(mode), 200)
                return
            if path == "/api/stop":
                self._json(stop_vm())
                return
            self._json({"ok": False, "error": "Not found."}, 404)
        except ValueError as exc:
            last_error = str(exc)
            self._json({"ok": False, "error": str(exc)}, 400)
        except RuntimeError as exc:
            last_error = str(exc)
            self._json({"ok": False, "error": str(exc)}, 409)
        except OSError as exc:
            last_error = str(exc)
            print(f"[error] {path}: {exc}", flush=True)
            self._json({"ok": False, "error": f"Server I/O error: {exc}"}, 500)
        except Exception as exc:
            last_error = str(exc)
            traceback.print_exc()
            self._json({"ok": False, "error": f"Internal server error: {exc}"}, 500)


def main():
    print("Android Browser Boot control server", flush=True)
    print(f"Root: {ROOT}", flush=True)
    print(f"Control UI: http://{HOST}:{PORT}", flush=True)
    try:
        ensure_vnc_proxy()
        print(f"noVNC/WebSocket proxy: port {VNC_PORT} -> {VNC_TARGET}", flush=True)
    except Exception as exc:
        print(f"WARNING: noVNC proxy not started: {exc}", flush=True)
        print("Install dependencies with ./INSTALL.sh, then restart ./START.sh.", flush=True)
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("Stopping...", flush=True)
    finally:
        stop_vm()
        global vnc_proc
        if vnc_proc is not None and vnc_proc.poll() is None:
            vnc_proc.terminate()
            try:
                vnc_proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                vnc_proc.kill()
        server.server_close()

if __name__ == "__main__":
    main()
