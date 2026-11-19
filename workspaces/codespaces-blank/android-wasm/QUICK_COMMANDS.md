# Quick commands

```bash
# Start the control page (installs native fallback dependencies if missing)
./START.sh

# Verify installed dependencies and ports
./CHECK_ENV.sh

# Stop the native Android VM
./STOP.sh
```

Open the forwarded **8000** port. Select the ISO in the page to save it to
browser OPFS; it is not uploaded to the Codespace. ISO boot is unavailable
until QEMU-WASM and an OPFS CD-ROM adapter are integrated. The native fallback
can boot an already-installed disk. Forward **6080** as Private if
Codespaces prompts.
