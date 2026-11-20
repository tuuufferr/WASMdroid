let qemuModule = null;
let diskAccess = null;
let isoFile = null;
let ptyMaster = null;
let writeToPty = null;
let ready = false;
let stopRequested = false;
let finished = false;
let serialOffset = 0;
let serialTimer = null;
let monitorOutput = '';
let blockInfoPending = false;
let blockInfoOutput = '';
let blockInfoTimer = null;
let monitorInputBuffer = null;
let monitorInputControl = null;
let monitorInputBytes = null;
let monitorInputConsumed = false;
const monitorDecoder = new TextDecoder();

const DISK_BYTES = 8 * 1024 ** 3;
const ISO_PATH = '/opfs/android-x86.iso';
const DISK_PATH = '/opfs/android-data.raw';
const MONITOR_HEADER_BYTES = 8;
const MONITOR_CAPACITY = 4096;

function post(type, fields = {}) {
  self.postMessage({type, ...fields});
}

function errno(FS, code, message) {
  const error = new FS.ErrnoError(code);
  if (message) error.message = message;
  return error;
}

function addOpfsFile(FS, directory, name, mode, size, read, write, truncate, sync) {
  const node = FS.createNode(directory, name, mode);
  node.size = size();
  node.timestamp = Date.now();
  node.node_ops = {
    getattr(current) {
      const currentSize = size();
      current.size = currentSize;
      const timestamp = new Date(current.timestamp);
      return {
        dev: 1,
        ino: current.id,
        mode: current.mode,
        nlink: 1,
        uid: 0,
        gid: 0,
        rdev: 0,
        size: currentSize,
        atime: timestamp,
        mtime: timestamp,
        ctime: timestamp,
        blksize: 4096,
        blocks: Math.ceil(currentSize / 4096),
      };
    },
    setattr(current, attr) {
      if (attr.size !== undefined) {
        if (!truncate) throw errno(FS, 30, 'The Android ISO is read-only.');
        truncate(attr.size);
        current.size = attr.size;
      }
      if (attr.mode !== undefined) current.mode = attr.mode;
      if (attr.timestamp !== undefined) current.timestamp = attr.timestamp;
    },
  };
  node.stream_ops = {
    open(stream) {
      if ((stream.flags & 3) !== 0 && !write) {
        throw errno(FS, 30, 'The Android ISO is read-only.');
      }
    },
    close() {
      if (sync) sync();
    },
    read(stream, buffer, offset, length, position) {
      if (position < 0) throw errno(FS, 22, 'Negative file offset.');
      return read(buffer, offset, length, position);
    },
    write(stream, buffer, offset, length, position) {
      if (!write) throw errno(FS, 30, 'The Android ISO is read-only.');
      if (position < 0 || position + length > DISK_BYTES) {
        throw errno(FS, 27, 'Write exceeds the fixed 8 GiB virtual disk.');
      }
      return write(buffer, offset, length, position);
    },
    llseek(stream, offset, whence) {
      let position = offset;
      if (whence === 1) position += stream.position;
      else if (whence === 2) position += size();
      if (position < 0) throw errno(FS, 22, 'Negative file offset.');
      return position;
    },
    fsync() {
      if (sync) sync();
    },
  };
  directory.contents[name] = node;
  return node;
}

function mountOpfs(FS) {
  FS.mkdir('/opfs');
  const directory = FS.lookupPath('/opfs').node;
  const reader = new FileReaderSync();
  addOpfsFile(
    FS,
    directory,
    'android-x86.iso',
    0x8000 | 0o444,
    () => isoFile.size,
    (buffer, offset, length, position) => {
      if (position >= isoFile.size) return 0;
      const part = isoFile.slice(position, Math.min(position + length, isoFile.size));
      const bytes = new Uint8Array(reader.readAsArrayBuffer(part));
      buffer.set(bytes, offset);
      return bytes.byteLength;
    },
    null,
    null,
    null,
  );
  addOpfsFile(
    FS,
    directory,
    'android-data.raw',
    0x8000 | 0o666,
    () => diskAccess.getSize(),
    (buffer, offset, length, position) =>
      diskAccess.read(buffer.subarray(offset, offset + length), {at: position}),
    (buffer, offset, length, position) =>
      diskAccess.write(buffer.subarray(offset, offset + length), {at: position}),
    size => diskAccess.truncate(size),
    () => diskAccess.flush(),
  );
  post('status', {message: 'OPFS mounted: ISO read-only; 8 GiB raw disk random-access and writable.'});
}

function flushSerial() {
  if (!qemuModule || !qemuModule.FS) return;
  try {
    const bytes = qemuModule.FS.readFile('/tmp/qemu-serial.log');
    if (bytes.length > serialOffset) {
      const chunk = bytes.subarray(serialOffset);
      serialOffset = bytes.length;
      post('serial-output', {data: new TextDecoder().decode(chunk)});
    }
  } catch (error) {
    if (error.code !== 'ENOENT') post('error', {message: `Could not read QEMU serial output: ${error.message}`});
  }
}

function closeDiskAccess() {
  let flushError = '';
  if (diskAccess) {
    try {
      diskAccess.flush();
    } catch (error) {
      flushError = error.message;
    }
    try {
      diskAccess.close();
    } catch (error) {
      flushError ||= error.message;
    }
    diskAccess = null;
  }
  return flushError;
}

function finish(exitCode, errorMessage = '') {
  if (finished) return;
  finished = true;
  if (serialTimer) clearInterval(serialTimer);
  if (blockInfoTimer) clearTimeout(blockInfoTimer);
  blockInfoTimer = null;
  blockInfoPending = false;
  flushSerial();
  const flushError = closeDiskAccess();
  post('stopped', {exitCode, error: errorMessage, flushError});
  setTimeout(() => self.close(), 0);
}

function monitorPromptAtEnd(text) {
  const plain = String(text)
    .replace(/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r/g, '')
    .trimEnd();
  return /\(qemu\)\s*$/.test(plain);
}

function completeBlockInfo(timedOut = false, error = '') {
  if (!blockInfoPending) return;
  blockInfoPending = false;
  if (blockInfoTimer) clearTimeout(blockInfoTimer);
  blockInfoTimer = null;
  post('block-devices', {
    isoAttached: blockInfoOutput.includes(ISO_PATH),
    diskAttached: blockInfoOutput.includes(DISK_PATH),
    timedOut,
    error,
    inputConsumed: monitorInputConsumed,
    detail: blockInfoOutput.slice(-4000),
  });
}

function requestBlockInfo() {
  if (blockInfoPending || !writeToPty || finished) return;
  blockInfoPending = true;
  blockInfoOutput = '';
  monitorInputConsumed = false;

  // Start the timeout before attempting to write. A failed send must still
  // result in a visible failure instead of an infinite "checking" state.
  blockInfoTimer = setTimeout(() => {
    completeBlockInfo(true, 'QEMU did not return the info block response within 30 seconds.');
  }, 30000);

  setTimeout(() => {
    if (!blockInfoPending || finished) return;
    try {
      sendMonitorCommand('info block');
    } catch (error) {
      completeBlockInfo(true, `Could not send info block: ${error.message}`);
    }
  }, 0);
}

function onMonitorData(bytes, acknowledge) {
  const text = monitorDecoder.decode(Uint8Array.from(bytes), {stream: true});
  monitorOutput = (monitorOutput + text).slice(-16000);
  post('monitor-output', {data: text});

  let blockInfoComplete = false;
  if (blockInfoPending) {
    blockInfoOutput = (blockInfoOutput + text).slice(-8000);
    blockInfoComplete = monitorPromptAtEnd(blockInfoOutput)
      || (blockInfoOutput.includes(ISO_PATH) && blockInfoOutput.includes(DISK_PATH));
  }
  const firstPrompt = !ready && monitorPromptAtEnd(monitorOutput);

  // Release the PTY output queue before scheduling another monitor command.
  if (acknowledge) {
    try {
      acknowledge();
    } catch (error) {
      post('error', {message: `Could not acknowledge QEMU monitor output: ${error.message}`});
    }
  }

  if (blockInfoComplete) completeBlockInfo(false);

  if (firstPrompt) {
    ready = true;
    post('ready', {
      machine: 'pc (i440FX/PIIX IDE)',
      devices: 'Monitor prompt detected; testing monitor input channel.',
    });
    if (stopRequested) {
      setTimeout(() => {
        try {
          if (writeToPty) writeToPty('quit\r');
        } catch (error) {
          post('error', {message: `Could not send QEMU quit command: ${error.message}`});
        }
      }, 0);
    } else {
      setTimeout(requestBlockInfo, 0);
    }
  }
}

function attachSharedMonitorInput(slave, buffer) {
  if (!(buffer instanceof SharedArrayBuffer) ||
      buffer.byteLength < MONITOR_HEADER_BYTES + MONITOR_CAPACITY) {
    throw new Error('The shared QEMU monitor input buffer is unavailable or invalid.');
  }
  monitorInputBuffer = buffer;
  monitorInputControl = new Int32Array(buffer, 0, 2);
  monitorInputBytes = new Uint8Array(buffer, MONITOR_HEADER_BYTES, MONITOR_CAPACITY);

  const readableDescriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(slave),
    'readable',
  );
  const originalReadable = readableDescriptor.get.bind(slave);
  const originalRead = slave.read.bind(slave);
  Object.defineProperty(slave, 'readable', {
    get() {
      return originalReadable()
        || Atomics.load(monitorInputControl, 0) !== Atomics.load(monitorInputControl, 1);
    },
  });
  slave.read = length => {
    const wakeBytes = originalRead(length);
    if (!length) return wakeBytes;

    const readIndex = Atomics.load(monitorInputControl, 0);
    const writeIndex = Atomics.load(monitorInputControl, 1);
    if (readIndex === writeIndex) return wakeBytes;

    const available = (writeIndex - readIndex + MONITOR_CAPACITY) % MONITOR_CAPACITY;
    const count = Math.min(length, available);
    const bytes = new Uint8Array(count);
    for (let index = 0; index < count; index++) {
      bytes[index] = monitorInputBytes[(readIndex + index) % MONITOR_CAPACITY];
    }
    Atomics.store(monitorInputControl, 0, (readIndex + count) % MONITOR_CAPACITY);
    Atomics.notify(monitorInputControl, 0);
    monitorInputConsumed = true;
    post('monitor-pty-read', {
      bytes: count,
      data: new TextDecoder().decode(bytes),
    });
    return Array.from(bytes);
  };
}

function sendMonitorCommand(command) {
  if (!monitorInputBuffer || !monitorInputControl || !monitorInputBytes || !writeToPty) {
    throw new Error('The shared QEMU monitor input channel is unavailable.');
  }
  const bytes = new TextEncoder().encode(`${command}\r`);
  if (bytes.length > MONITOR_CAPACITY - 1) {
    throw new Error('The QEMU monitor command is too long.');
  }

  const readIndex = Atomics.load(monitorInputControl, 0);
  let writeIndex = Atomics.load(monitorInputControl, 1);
  const used = (writeIndex - readIndex + MONITOR_CAPACITY) % MONITOR_CAPACITY;
  if (bytes.length > MONITOR_CAPACITY - used - 1) {
    throw new Error('The QEMU monitor is still processing input. Wait and try again.');
  }
  for (const byte of bytes) {
    monitorInputBytes[writeIndex] = byte;
    writeIndex = (writeIndex + 1) % MONITOR_CAPACITY;
  }
  Atomics.store(monitorInputControl, 1, writeIndex);
  Atomics.notify(monitorInputControl, 1);

  // The shared ring buffer carries the command; a PTY newline only wakes
  // QEMU's poll/read path so it checks that buffer.
  writeToPty('\n');
  post('monitor-input-sent', {
    bytes: bytes.length,
    slaveReadable: true,
    transport: 'shared buffer',
  });
}

function activatePty(master) {
  const dataListeners = new Set();
  const binaryListeners = new Set();
  const resizeListeners = new Set();


  master.activate({
    cols: 80,
    rows: 24,
    write: (bytes, acknowledge) => onMonitorData(bytes, acknowledge),
    onData(callback) {
      dataListeners.add(callback);
      return {dispose: () => dataListeners.delete(callback)};
    },
    onBinary(callback) {
      binaryListeners.add(callback);
      return {dispose: () => binaryListeners.delete(callback)};
    },
    onResize(callback) {
      resizeListeners.add(callback);
      return {dispose: () => resizeListeners.delete(callback)};
    },
  });


  return text => {
    const input = String(text);
    const lineDiscipline = master.ldisc;


    if (!lineDiscipline ||
        typeof lineDiscipline.writeFromLower !== 'function') {
      throw new Error('PTY master line discipline is unavailable.');
    }


    // This is the same input path used by xterm-pty's master addon.
    // It queues bytes for slave.read() and signals the QEMU-side reader.
    lineDiscipline.writeFromLower(input);


    post('monitor-input-sent', {
      bytes: new TextEncoder().encode(input).length,
      slaveReadable: Boolean(slave.readable),
    });
  };
}


function probeWorkerWebGL() {
  if (typeof OffscreenCanvas !== 'function') return {ok: false, detail: 'OffscreenCanvas unavailable in worker.'};
  try {
    const probe = new OffscreenCanvas(4, 4);
    const gl = probe.getContext('webgl', {alpha: false, antialias: false});
    if (!gl) return {ok: false, detail: 'Worker WebGL 1 context creation failed.'};
    gl.disable(gl.DITHER);
    gl.viewport(0, 0, 4, 4);
    gl.clearColor(0.25, 0.5, 0.75, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.finish();
    const pixel = new Uint8Array(4);
    gl.readPixels(1, 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const expected = [64, 128, 191, 255];
    const ok = expected.every((v, i) => Math.abs(pixel[i] - v) <= 4);
    const version = String(gl.getParameter(gl.VERSION) || 'WebGL 1');
    const lose = gl.getExtension('WEBGL_lose_context');
    if (lose) lose.loseContext();
    return {
      ok,
      version,
      detail: ok ? `Worker WebGL pixel readback passed (${version}).`
                 : `WebGL pixel readback mismatch: ${Array.from(pixel).join(',')}`,
    };
  } catch (e) {
    return {ok: false, detail: `Worker WebGL test failed: ${e.message}`};
  }
}

async function openStorage() {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
    throw new Error('OPFS is unavailable in this browser worker; use a current browser over HTTPS.');
  }
  const root = await navigator.storage.getDirectory();
  const isoDirectory = await root.getDirectoryHandle('android-iso');
  const diskDirectory = await root.getDirectoryHandle('android-disk');
  const isoHandle = await isoDirectory.getFileHandle('android-x86.iso');
  const diskHandle = await diskDirectory.getFileHandle('android-data.raw');
  isoFile = await isoHandle.getFile();
  if (!isoFile.size) throw new Error('The saved Android ISO is empty.');
  const diskFile = await diskHandle.getFile();
  if (diskFile.size !== DISK_BYTES) {
    throw new Error(`The OPFS disk must be exactly 8 GiB; found ${diskFile.size} bytes.`);
  }
  if (typeof diskHandle.createSyncAccessHandle !== 'function') {
    throw new Error('This browser does not support OPFS synchronous access handles in workers.');
  }
  diskAccess = await diskHandle.createSyncAccessHandle();
  if (diskAccess.getSize() !== DISK_BYTES) {
    throw new Error(`OPFS disk size changed while opening it: expected ${DISK_BYTES}, found ${diskAccess.getSize()}.`);
  }
  post('status', {
    message: `Opened OPFS ISO (${isoFile.size} bytes) without reading it into memory and writable 8 GiB raw disk.`,
  });
}

async function start(message) {
  try {
    if (!message.canvas) throw new Error('The QEMU display canvas was not transferred to the worker.');
    message.canvas.id = 'qemuScreen';
    if (message.canvas.id !== 'qemuScreen') {
      throw new Error('Could not assign QEMU canvas ID for PThread transfer.');
    }
    const graphics = probeWorkerWebGL();
    post('graphics-preflight', graphics);
    if (!graphics.ok) throw new Error(graphics.detail);
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error('QEMU-WASM requires SharedArrayBuffer. Serve this page with Cross-Origin-Opener-Policy: same-origin and Cross-Origin-Embedder-Policy: require-corp.');
    }
    await openStorage();
    importScripts('./pty.js');
    const {master, slave} = openpty();
    attachSharedMonitorInput(slave, message.monitorBuffer);
    ptyMaster = master;
    writeToPty = activatePty(master);

    const mode = message.mode === 'disk' ? 'disk' : 'iso';
    const moduleUrl = new URL('./qemu-system-x86_64.js', self.location.href).href;
    qemuModule = {
      arguments: [
        '-name', 'android-x86-qemu-wasm',
        '-machine', 'pc',
        '-accel', 'tcg,thread=multi,tb-size=500',
        '-cpu', 'max',
        '-smp', '1',
        '-m', '1024',
        '-L', '/pack',
        '-drive', 'id=android-disk,if=none,file=/opfs/android-data.raw,format=raw,cache=writeback',
        '-device', 'ide-hd,drive=android-disk,bus=ide.0,unit=0',
        '-drive', 'id=android-cd,if=none,file=/opfs/android-x86.iso,format=raw,media=cdrom,readonly=on',
        '-device', 'ide-cd,drive=android-cd,bus=ide.1,unit=0',
        '-nic', 'none',
        '-boot', mode === 'disk' ? 'order=c' : 'order=d',
        '-vga', 'std',
        '-display', 'sdl',
        '-serial', 'file:/tmp/qemu-serial.log',
        '-monitor', 'stdio',
        '-no-reboot',
      ],
      canvas: message.canvas,
      pty: slave,
      mainScriptUrlOrBlob: moduleUrl,
      noExitRuntime: false,
      onRuntimeInitialized: () => {
        serialTimer = setInterval(flushSerial, 1000);
      },
      print: text => post('status', {message: String(text)}),
      printErr: text => post('status', {message: String(text)}),
      onExit: code => finish(code),
      onAbort: reason => {
        post('error', {message: `QEMU-WASM aborted: ${String(reason)}`});
        finish(null, String(reason));
      },
    };
    self.Module = qemuModule;
    importScripts('./load.js');
    const priorPreRun = qemuModule.preRun || [];
    qemuModule.preRun = [...priorPreRun, () => mountOpfs(qemuModule.FS)];
    const {default: initializeQemu} = await import(moduleUrl);
    await initializeQemu(qemuModule);
  } catch (error) {
    post('error', {message: `QEMU-WASM startup failed: ${error.message}`});
    finish(null, error.message);
  }
}

self.addEventListener('message', event => {
  const message = event.data || {};
  if (message.type === 'start') {
    void start(message);
    return;
  }
  if (message.type === 'stop') {
    stopRequested = true;
    if (writeToPty && ready) {
      try {
        sendMonitorCommand('quit');
      } catch (error) {
        post('error', {message: `Could not send QEMU quit command: ${error.message}`});
      }
    }
    return;
  }
  if (message.type === 'monitor' && ptyMaster && ready) {
    const command = String(message.command || '').trim();
    if (!command || command.length > 4096) return;
    try {
      sendMonitorCommand(command);
    } catch (error) {
      post('error', {message: `Could not send QEMU monitor command: ${error.message}`});
    }
  }
});
