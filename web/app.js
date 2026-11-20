const $ = id => document.getElementById(id);
const ISO_STORAGE_NAME = 'android-x86.iso';
const ISO_METADATA_NAME = 'android-x86-metadata.json';
const DISK_STORAGE_NAME = 'android-data.raw';
const DISK_CAPACITY_BYTES = 8 * 1024 ** 3;
let diskError = '';
let wasmManifest = null;
let wasmWorker = null;
let wasmReady = false; // QEMU monitor ready; not proof of Android boot.
let wasmEverStarted = false;
let wasmIsoAttached = false;
let wasmDiskAttached = false;
let wasmBlockInfoReceived = false;
let wasmGraphicsPreflight = null;
let wasmCanvasTransferred = false;
let wasmGuestBootObserved = false;
let wasmMonitorLog = '';
let wasmSerialLog = '';
let lastStorageState = {storedIso: null, storedDisk: null, storageError: '', diskReadError: ''};
let startPrerequisitesMet = false;
let stopTimeout = null;

const api = async (path, options = {}) => {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({error: `HTTP ${res.status}`}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
};

function vncUrl() {
  const host = location.host.replace(/-8000(?=\.|$)/, '-6080').replace(/:8000$/, ':6080');
  return `${location.protocol}//${host}/vnc.html?autoconnect=true&resize=scale`;
}

function setMessage(id, text, isError = false) {
  const el = $(id);
  el.textContent = text;
  el.className = 'statusline ' + (isError ? 'bad' : 'muted');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toFixed(1)} ${units[unit]}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

async function getIsoDirectory() {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
    throw new Error('This browser does not support OPFS. Open the page in a current browser over HTTPS and try again.');
  }
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('android-iso', {create: true});
  } catch (error) {
    if (error.name === 'QuotaExceededError') {
      throw new Error('Not enough browser storage to initialize OPFS. Free browser storage and try again.');
    }
    throw new Error(`Browser private storage is unavailable: ${error.message}`);
  }
}

async function getDiskDirectory() {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') {
    throw new Error('This browser does not support OPFS. Open the page in a current browser over HTTPS and try again.');
  }
  try {
    const root = await navigator.storage.getDirectory();
    return await root.getDirectoryHandle('android-disk', {create: true});
  } catch (error) {
    if (error.name === 'QuotaExceededError') {
      throw new Error('Not enough browser storage to initialize the virtual disk. Free browser storage and try again.');
    }
    throw new Error(`Browser private storage is unavailable: ${error.message}`);
  }
}

async function readStoredDisk() {
  const directory = await getDiskDirectory();
  let handle;
  try {
    handle = await directory.getFileHandle(DISK_STORAGE_NAME);
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
  return await handle.getFile();
}

async function checkDiskQuota(reclaimedBytes = 0) {
  if (!navigator.storage.estimate) {
    throw new Error('Cannot safely create the virtual disk because this browser does not report its storage quota.');
  }
  const {usage, quota} = await navigator.storage.estimate();
  if (!Number.isFinite(usage) || !Number.isFinite(quota)) {
    throw new Error('Cannot safely create the virtual disk because the browser returned an invalid storage quota.');
  }
  const available = Math.max(0, quota - usage) + reclaimedBytes;
  if (available < DISK_CAPACITY_BYTES) {
    throw new Error(`Not enough browser storage for an 8 GiB virtual disk: ${formatBytes(available)} available.`);
  }
}

async function requestStoragePersistence() {
  if (!navigator.storage.persist) return false;
  try {
    return await navigator.storage.persist();
  } catch (error) {
    console.warn('Could not request persistent browser storage:', error);
    return false;
  }
}

async function readWasmManifest() {
  const response = await fetch(new URL('qemu-wasm/manifest.json', document.baseURI), {cache: 'no-store'});
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Could not check the QEMU-WASM build: HTTP ${response.status}`);
  const manifest = await response.json();
  if (manifest.target !== 'x86_64-softmmu' || !manifest.qemuVersion || !manifest.sourceRevision) {
    throw new Error('The QEMU-WASM build manifest is invalid or for an unsupported target.');
  }
  return manifest;
}

async function createVirtualDisk(reset = false) {
  const directory = await getDiskDirectory();
  let previousFile = null;
  try {
    const previousHandle = await directory.getFileHandle(DISK_STORAGE_NAME);
    previousFile = await previousHandle.getFile();
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
  }

  if (previousFile && !reset) {
    if (previousFile.size !== DISK_CAPACITY_BYTES) {
      throw new Error(`The existing virtual disk has an unexpected size (${formatBytes(previousFile.size)}). Reset it to create a fresh 8 GiB disk.`);
    }
    const persistent = await requestStoragePersistence();
    return {file: previousFile, reused: true, persistent};
  }

  await checkDiskQuota(previousFile ? previousFile.size : 0);
  if (previousFile) await directory.removeEntry(DISK_STORAGE_NAME);

  let created = false;
  try {
    const handle = await directory.getFileHandle(DISK_STORAGE_NAME, {create: true});
    created = true;
    const writable = await handle.createWritable();
    await writable.truncate(DISK_CAPACITY_BYTES);
    await writable.close();
    const file = await handle.getFile();
    if (file.size !== DISK_CAPACITY_BYTES) {
      throw new Error(`Virtual disk size verification failed: expected ${formatBytes(DISK_CAPACITY_BYTES)}, found ${formatBytes(file.size)}.`);
    }
    const persistent = await requestStoragePersistence();
    return {file, reused: false, persistent};
  } catch (error) {
    if (created) {
      try {
        await directory.removeEntry(DISK_STORAGE_NAME);
      } catch (cleanupError) {
        console.warn('Could not remove the incomplete virtual disk:', cleanupError);
      }
    }
    if (error.name === 'QuotaExceededError') {
      throw new Error('Browser storage quota was exceeded while creating the 8 GiB virtual disk. Free browser storage and try again.');
    }
    throw error;
  }
}

async function readStoredIso() {
  const directory = await getIsoDirectory();
  let handle;
  try {
    handle = await directory.getFileHandle(ISO_STORAGE_NAME);
  } catch (error) {
    if (error.name === 'NotFoundError') return null;
    throw error;
  }
  const file = await handle.getFile();
  if (!file.size) {
    throw new Error('The saved ISO is empty. Select the complete Android-x86 ISO and save it again.');
  }
  let originalName = ISO_STORAGE_NAME;
  try {
    const metadataHandle = await directory.getFileHandle(ISO_METADATA_NAME);
    const metadata = JSON.parse(await (await metadataHandle.getFile()).text());
    if (Number.isSafeInteger(metadata.size) && metadata.size !== file.size) {
      throw new Error(`Stored ISO size mismatch: metadata says ${metadata.size} bytes, file contains ${file.size} bytes.`);
    }
    if (typeof metadata.name === 'string') originalName = metadata.name;
  } catch (error) {
    if (error.name !== 'NotFoundError' && !(error instanceof SyntaxError)) throw error;
  }
  return {file, originalName};
}

async function writeMetadata(directory, metadata) {
  const handle = await directory.getFileHandle(ISO_METADATA_NAME, {create: true});
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(metadata));
  await writable.close();
}

async function saveIso(sourceFile) {
  if (!sourceFile.name.toLowerCase().endsWith('.iso')) {
    throw new Error('The selected file must end in .iso.');
  }
  if (/[\\/]/.test(sourceFile.name)) {
    throw new Error('The selected ISO has an invalid file name.');
  }

  const directory = await getIsoDirectory();
  if (navigator.storage.estimate) {
    const {usage, quota} = await navigator.storage.estimate();
    if (Number.isFinite(usage) && Number.isFinite(quota)) {
      const available = Math.max(0, quota - usage);
      if (available < sourceFile.size) {
        throw new Error(`Not enough browser storage: ${formatBytes(available)} available, but the ISO is ${formatBytes(sourceFile.size)}.`);
      }
    }
  }

  let persistent = false;
  if (navigator.storage.persist) {
    try {
      persistent = await navigator.storage.persist();
    } catch (error) {
      console.warn('Could not request persistent browser storage:', error);
    }
  }

  const handle = await directory.getFileHandle(ISO_STORAGE_NAME, {create: true});
  const writable = await handle.createWritable();
  const writer = writable.getWriter();
  const reader = sourceFile.stream().getReader();
  let written = 0;
  $('progressWrap').classList.remove('hidden');
  $('progressBar').style.width = '0%';
  $('progressWrap').setAttribute('aria-valuenow', '0');
  setMessage('uploadMessage', `Saving ${sourceFile.name} (${formatBytes(sourceFile.size)}) to browser storage…`);

  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      await writer.write(value);
      written += value.byteLength;
      const percent = sourceFile.size ? (written / sourceFile.size) * 100 : 100;
      $('progressBar').style.width = `${percent}%`;
      $('progressWrap').setAttribute('aria-valuenow', String(Math.floor(percent)));
      setMessage('uploadMessage', `Saving ${sourceFile.name}: ${formatBytes(written)} of ${formatBytes(sourceFile.size)} (${percent.toFixed(1)}%)`);
    }
    await writer.close();
  } catch (error) {
    try {
      await reader.cancel();
    } catch (cancelError) {
      console.warn('Could not cancel the ISO file reader:', cancelError);
    }
    try {
      await writer.abort();
    } catch (abortError) {
      console.warn('Could not abort the incomplete OPFS write:', abortError);
    }
    if (error.name === 'QuotaExceededError') {
      throw new Error(`Browser storage ran out of space while saving ${sourceFile.name}. Free storage and try again.`);
    }
    throw error;
  }

  const savedFile = await handle.getFile();
  if (savedFile.size !== sourceFile.size) {
    throw new Error(`Saved file size mismatch: expected ${sourceFile.size} bytes, found ${savedFile.size} bytes.`);
  }
  let metadataWarning = '';
  try {
    await writeMetadata(directory, {name: sourceFile.name, size: sourceFile.size});
  } catch (error) {
    metadataWarning = ` Original file name metadata was not saved: ${error.message}`;
  }
  const retention = persistent
    ? 'Browser storage persistence was granted.'
    : 'The browser may clear this storage under pressure; persistence was not granted.';
  setMessage('uploadMessage', `Save complete: ${sourceFile.name} · ${formatBytes(savedFile.size)} · size verified. ${retention}${metadataWarning}`);
  $('progressBar').style.width = '100%';
  $('progressWrap').setAttribute('aria-valuenow', '100');
  await refresh();
}

function hasWasmSharedMemorySupport() {
  return window.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
}

async function refresh() {
  try {
    let status;
    try {
      status = await api('/api/status');
    } catch (error) {
      // Static sites do not expose the optional Codespaces native-QEMU API.
      // Browser QEMU-WASM and OPFS must remain usable without that backend.
      status = {
        api_available: false,
        qemu: {installed: false, version: null, running: false, pid: null},
        qemu_img: {installed: false, version: null},
        novnc: {installed: false, web_root: null, proxy_running: false},
        qemu_tail: '', serial_tail: '', last_error: '',
      };
    }
    let runtimeError = '';
    try {
      wasmManifest = await readWasmManifest();
    } catch (error) {
      runtimeError = error.message;
      wasmManifest = null;
    }
    if (!wasmWorker) {
      lastStorageState = {
        storedIso: null, storedDisk: null, storageError: '', diskReadError: '',
      };
      try {
        lastStorageState.storedIso = await readStoredIso();
      } catch (error) {
        lastStorageState.storageError = error.message;
      }
      try {
        lastStorageState.storedDisk = await readStoredDisk();
      } catch (error) {
        lastStorageState.diskReadError = error.message;
      }
    }
    const {storedIso, storedDisk, storageError, diskReadError} = lastStorageState;
    const diskIsValid = Boolean(storedDisk && storedDisk.size === DISK_CAPACITY_BYTES);
    const runtimeAvailable = Boolean(wasmManifest);
    const sharedMemoryAvailable = hasWasmSharedMemorySupport();
    startPrerequisitesMet = Boolean(runtimeAvailable && storedIso && diskIsValid && sharedMemoryAvailable && !wasmWorker);
    const checks = [
      ['QEMU shared-memory support', sharedMemoryAvailable, sharedMemoryAvailable
        ? 'Cross-origin isolated; SharedArrayBuffer is available'
        : 'Serve with COOP: same-origin and COEP: require-corp over HTTPS or localhost'],
      ['Native QEMU (Codespace)', status.qemu.installed, status.qemu.version || 'not installed'],
      ['Native qemu-img', status.qemu_img.installed, status.qemu_img.version || 'not installed'],
      ['noVNC + websockify', status.novnc.installed, status.novnc.web_root || 'not installed'],
      ['Browser ISO (OPFS)', Boolean(storedIso), storedIso
        ? `${storedIso.originalName} · ${formatBytes(storedIso.file.size)}`
        : storageError || 'not saved in this browser'],
      ['Virtual disk (OPFS)', diskIsValid, storedDisk
        ? `${formatBytes(storedDisk.size)} raw disk`
        : diskReadError || diskError || 'not created'],
      ['QEMU-WASM runtime', runtimeAvailable, runtimeAvailable
        ? `QEMU ${wasmManifest.qemuVersion} · ${wasmManifest.sourceRevision.slice(0, 12)}`
        : runtimeError || 'not built; run BUILD_QEMU_WASM.sh'],
    ];
    $('checks').innerHTML = checks.map(([name, ok, detail]) =>
      `<div class="check"><b class="${ok ? 'good' : 'bad'}">${ok ? '✓' : '×'} ${escapeHtml(name)}</b><br><span class="muted">${escapeHtml(detail || '')}</span></div>`
    ).join('');
    $('isoInfo').textContent = storedIso
      ? `Saved in this browser: ${storedIso.originalName} · ${formatBytes(storedIso.file.size)} · ${storedIso.file.size} bytes`
      : storageError || 'No ISO saved in this browser yet.';
    $('diskCreatedStatus').textContent = diskIsValid
      ? 'Yes — present in browser OPFS'
      : storedDisk ? `No — invalid disk size (${formatBytes(storedDisk.size)})` : 'No';
    $('diskAttachedStatus').textContent = !wasmWorker
      ? 'No — QEMU-WASM is not running'
      : !wasmReady
        ? 'Waiting for the QEMU monitor'
        : !wasmBlockInfoReceived
          ? 'Monitor ready; checking info block…'
          : wasmDiskAttached
            ? 'Confirmed by QEMU info block'
            : 'Not confirmed by QEMU info block';
    $('graphicsStatus').textContent = wasmGraphicsPreflight === null
      ? 'Not run'
      : wasmGraphicsPreflight ? 'PASS — worker WebGL test' : 'FAIL — see QEMU output';
    $('monitorStatus').textContent = wasmReady ? 'Monitor prompt received' : wasmWorker ? 'Starting…' : 'Not started';
    $('isoAttachedStatus').textContent = wasmBlockInfoReceived
      ? wasmIsoAttached ? 'Confirmed by QEMU info block' : 'Not confirmed by QEMU info block'
      : 'Not verified';
    $('diskDeviceStatus').textContent = wasmBlockInfoReceived
      ? wasmDiskAttached ? 'Confirmed by QEMU info block' : 'Not confirmed by QEMU info block'
      : 'Not verified';
    $('canvasStatus').textContent = wasmCanvasTransferred
      ? 'Transferred to worker; guest frame not yet verified'
      : 'Not transferred';
    $('guestBootStatus').textContent = wasmGuestBootObserved
      ? 'Early Linux/Android serial marker seen; UI readiness not proven'
      : 'Not observed in serial output';
    $('diskCapacityStatus').textContent = storedDisk
      ? `${formatBytes(storedDisk.size)}${diskIsValid ? ' (raw)' : ' (expected 8 GiB raw)'}`
      : '8 GiB requested';
    const visibleDiskError = diskError || diskReadError;
    $('diskErrorStatus').textContent = visibleDiskError || 'None';
    $('diskErrorStatus').className = visibleDiskError ? 'bad' : 'good';
    $('startIso').disabled = !startPrerequisitesMet;
    $('startDisk').disabled = !startPrerequisitesMet;
    $('manageDisk').disabled = Boolean(wasmWorker);
    $('upload').disabled = Boolean(wasmWorker);
    $('stop').disabled = !wasmWorker && !status.qemu.running;
    $('sendMonitor').disabled = !wasmReady;
    $('vmState').textContent = wasmWorker
      ? wasmReady ? 'QEMU-WASM monitor ready' : 'QEMU-WASM starting'
      : status.qemu.running ? `Native fallback running · PID ${status.qemu.pid}` : wasmEverStarted ? 'QEMU-WASM stopped' : 'Not started';
    $('qemuLog').textContent = wasmEverStarted ? wasmMonitorLog || 'No QEMU monitor output yet.' : status.qemu_tail || 'No log yet.';
    $('serialLog').textContent = wasmEverStarted ? wasmSerialLog || 'No serial bytes yet.' : status.serial_tail || 'No serial bytes yet.';
    $('screenWrap').classList.toggle('hidden', !wasmWorker);
    if (!wasmWorker && status.qemu.running) {
      $('screenLink').classList.remove('hidden');
      $('vncLink').href = vncUrl();
    } else {
      $('screenLink').classList.add('hidden');
    }
    if (status.last_error) setMessage('vmMessage', status.last_error, true);
  } catch (error) {
    $('checks').textContent = error.message;
    $('isoInfo').textContent = error.message;
    $('startIso').disabled = true;
  }
}

async function initializeVirtualDisk() {
  try {
    const result = await createVirtualDisk();
    diskError = '';
    setMessage('diskMessage', result.reused
      ? 'Existing 8 GiB raw virtual disk reused.'
      : 'A new 8 GiB raw virtual disk was created in browser storage.');
    if (!result.persistent) {
      setMessage('diskMessage', `${$('diskMessage').textContent} Browser storage persistence was not granted; the browser may evict it under storage pressure.`);
    }
  } catch (error) {
    diskError = error.message;
    setMessage('diskMessage', error.message, true);
  }
  await refresh();
}

function appendWasmLog(which, text) {
  const maxLength = 250000;
  if (which === 'serial') {
    wasmSerialLog = (wasmSerialLog + text).slice(-maxLength);
    $('serialLog').textContent = wasmSerialLog;
    $('serialLog').scrollTop = $('serialLog').scrollHeight;
    if (/\bLinux version\b|\bBooting the Linux kernel\b|\bAndroid-x86\b|\bzygote\b|\bSystemServer\b/i.test(text)) {
      wasmGuestBootObserved = true;
      $('guestBootStatus').textContent = 'Early Linux/Android serial marker seen; UI readiness not proven';
    }
  } else {
    wasmMonitorLog = (wasmMonitorLog + text).slice(-maxLength);
    $('qemuLog').textContent = wasmMonitorLog;
    $('qemuLog').scrollTop = $('qemuLog').scrollHeight;
  }
}

function handleWasmWorkerMessage(event) {
  const message = event.data || {};
  if (message.type === 'monitor-output') appendWasmLog('monitor', message.data);
  if (message.type === 'monitor-input-sent') {
    appendWasmLog('monitor',
      `\n[PTY input queued: ${message.bytes} bytes; slaveReadable=${message.slaveReadable}]\n`);
  }
  if (message.type === 'monitor-pty-read') {
    appendWasmLog('monitor',
      `\n[PTY bytes consumed by QEMU: ${JSON.stringify(message.data)}]\n`);
  }
  if (message.type === 'serial-output') appendWasmLog('serial', message.data);
  if (message.type === 'status') setMessage('vmMessage', message.message);
  if (message.type === 'graphics-preflight') {
    wasmGraphicsPreflight = Boolean(message.ok);
    $('graphicsStatus').textContent = message.ok ? `PASS — ${message.detail}` : `FAIL — ${message.detail}`;
  }
  if (message.type === 'block-devices') {
    wasmBlockInfoReceived = true;
    wasmIsoAttached = Boolean(message.isoAttached);
    wasmDiskAttached = Boolean(message.diskAttached);
    const verificationNote = message.timedOut
      ? ' (monitor response timed out after 8 seconds)'
      : message.error ? ` (${message.error})` : '';
    const summary = `QEMU info block: ISO ${wasmIsoAttached ? 'confirmed' : 'NOT confirmed'}; disk ${wasmDiskAttached ? 'confirmed' : 'NOT confirmed'}${verificationNote}.`;
    setMessage('vmMessage', summary, !(wasmIsoAttached && wasmDiskAttached));
    if (message.detail) appendWasmLog('monitor', `\n[info block verification]\n${message.detail}`);
    void refresh();
  }
  if (message.type === 'ready') {
    wasmReady = true;
    wasmEverStarted = true;
    setMessage('vmMessage', 'QEMU monitor ready; checking ISO and disk with info block…');
    $('sendMonitor').disabled = false;
  }
  if (message.type === 'error') {
    wasmReady = false;
    setMessage('vmMessage', message.message || 'QEMU-WASM failed.', true);
  }
  if (message.type === 'stopped') {
    if (stopTimeout) clearTimeout(stopTimeout);
    stopTimeout = null;
    wasmReady = false;
    wasmEverStarted = true;
    wasmWorker = null;
    wasmIsoAttached = false;
    wasmDiskAttached = false;
    wasmBlockInfoReceived = false;
    wasmCanvasTransferred = false;
    if (message.flushError) {
      setMessage('vmMessage', `QEMU stopped, but OPFS disk flush failed: ${message.flushError}`, true);
    } else {
      setMessage('vmMessage', message.error || 'QEMU-WASM stopped; OPFS disk flushed and closed.');
    }
    void refresh();
  }
}

async function startWasmVm(mode) {
  if (!hasWasmSharedMemorySupport()) {
    setMessage('vmMessage', 'QEMU-WASM requires SharedArrayBuffer. Open this page from a server using COOP: same-origin and COEP: require-corp over HTTPS or localhost.', true);
    return;
  }
  if (!startPrerequisitesMet || wasmWorker) {
    setMessage('vmMessage', 'The QEMU-WASM runtime, browser ISO, and valid OPFS disk must all be ready.', true);
    return;
  }
  $('startIso').disabled = true;
  $('startDisk').disabled = true;
  wasmMonitorLog = '';
  wasmSerialLog = '';
  wasmReady = false;
  wasmIsoAttached = false;
  wasmDiskAttached = false;
  wasmBlockInfoReceived = false;
  wasmGraphicsPreflight = null;
  wasmCanvasTransferred = false;
  wasmGuestBootObserved = false;
  wasmEverStarted = true;
  const oldCanvas = $('qemuScreen');
  const canvas = oldCanvas.cloneNode(false);
  oldCanvas.replaceWith(canvas);
  let offscreen;
  try {
    if (typeof canvas.transferControlToOffscreen !== 'function') {
      throw new Error('This browser does not support transferring the QEMU display to a worker.');
    }
    offscreen = canvas.transferControlToOffscreen();
  } catch (error) {
    setMessage('vmMessage', error.message, true);
    await refresh();
    return;
  }
  const workerUrl = new URL('qemu-wasm/worker.js', document.baseURI);
  const worker = new Worker(workerUrl);
  wasmWorker = worker;
  worker.addEventListener('message', handleWasmWorkerMessage);
  worker.addEventListener('error', event => {
    setMessage('vmMessage', `QEMU-WASM worker error: ${event.message}`, true);
  });
  wasmCanvasTransferred = true;
  $('canvasStatus').textContent = 'Transferred to worker; guest frame not yet verified';
  worker.postMessage({type: 'start', mode, canvas: offscreen}, [offscreen]);
  $('vmState').textContent = 'QEMU-WASM starting';
  $('screenWrap').classList.remove('hidden');
  setMessage('vmMessage', 'Opening OPFS files and initializing QEMU-WASM…');
  await refresh();
}

async function stopWasmVm() {
  if (!wasmWorker) return false;
  try {
    // The worker writes to the PTY master, which wakes QEMU's monitor reader.
    wasmWorker.postMessage({type: 'stop'});
  } catch (error) {
    setMessage('vmMessage', error.message, true);
    return false;
  }
  setMessage('vmMessage', 'Requesting a clean QEMU shutdown and OPFS flush…');
  $('stop').disabled = true;
  if (stopTimeout) clearTimeout(stopTimeout);
  stopTimeout = setTimeout(() => {
    if (wasmWorker) {
      $('stop').disabled = false;
      setMessage('vmMessage', 'QEMU has not exited yet. The worker and OPFS handle remain open; retry the stop request rather than forcing termination.', true);
    }
  }, 15000);
  return true;
}

$('refresh').addEventListener('click', refresh);
$('upload').addEventListener('click', async () => {
  const file = $('isoFile').files[0];
  if (!file) {
    setMessage('uploadMessage', 'Choose an ISO file first.', true);
    return;
  }
  $('upload').disabled = true;
  try {
    await saveIso(file);
  } catch (error) {
    setMessage('uploadMessage', error.message, true);
    if (error.name === 'QuotaExceededError') {
      setMessage('uploadMessage', `Not enough browser storage to save ${file.name}. Free storage and try again.`, true);
    }
  } finally {
    $('upload').disabled = false;
  }
});

$('manageDisk').addEventListener('click', async () => {
  if (wasmWorker) return;
  let existing;
  try {
    existing = await readStoredDisk();
  } catch (error) {
    diskError = error.message;
    await refresh();
    return;
  }
  const reset = Boolean(existing);
  if (reset && !confirm('Reset the virtual disk? This permanently deletes all data currently stored on it.')) return;
  $('manageDisk').disabled = true;
  try {
    const result = await createVirtualDisk(reset);
    diskError = '';
    setMessage('diskMessage', result.reused
      ? 'Existing 8 GiB virtual disk reused.'
      : 'A new 8 GiB raw virtual disk was created in browser storage.');
    if (!result.persistent) {
      setMessage('diskMessage', `${$('diskMessage').textContent} Browser storage persistence was not granted; the browser may evict it under storage pressure.`);
    }
  } catch (error) {
    diskError = error.message;
    setMessage('diskMessage', error.message, true);
  } finally {
    $('manageDisk').disabled = false;
    await refresh();
  }
});
$('startIso').addEventListener('click', () => startWasmVm('iso'));
$('startDisk').addEventListener('click', () => startWasmVm('disk'));
$('sendMonitor').addEventListener('click', () => {
  const command = $('monitorCommand').value.trim();
  if (!command || !wasmWorker || !wasmReady) return;
  try {
    // Do not write into a shared ring buffer: the worker's PTY path emits
    // the readable event QEMU is waiting for.
    wasmWorker.postMessage({type: 'monitor', command});
    $('monitorCommand').value = '';
  } catch (error) {
    setMessage('vmMessage', error.message, true);
  }
});
$('monitorCommand').addEventListener('keydown', event => {
  if (event.key === 'Enter') $('sendMonitor').click();
});
$('stop').addEventListener('click', async () => {
  if (await stopWasmVm()) return;
  try {
    await api('/api/stop', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: '{}',
    });
    setMessage('vmMessage', 'Android VM stopped.');
    await refresh();
  } catch (error) {
    setMessage('vmMessage', error.message, true);
  }
});

setMessage('diskMessage', 'Checking browser storage and preparing the virtual disk…');
initializeVirtualDisk();
setInterval(refresh, 3000);
