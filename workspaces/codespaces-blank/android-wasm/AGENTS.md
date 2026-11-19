# Coding-agent guardrails

This package has two separate emulator paths: a browser QEMU-WASM route backed
by OPFS and a native-QEMU + noVNC fallback. Do not substitute one for the
other or claim that native QEMU can access browser OPFS.

- Preserve the user's ISO and virtual disk; never overwrite either without explicit instruction.
- Keep QEMU VNC bound to 127.0.0.1:5901. Do not expose port 5901 publicly.
- Keep ports 8000 and 6080 Private in Codespaces.
- Verify browser guest boot in the QEMU-WASM display and native-fallback boot in noVNC; process creation alone is not proof of boot.
- Do not claim GMS or Google Play is included.
- Do not claim Roblox works until tested on this exact guest build.
- Diagnose one variable at a time; never request repeated identical reboots/logs.
- Keep QEMU-WASM asset loading, its OPFS adapter, and the native fallback separate.
- Verify block attachment with QEMU monitor output and persistence with a sector read after a clean emulator restart.
