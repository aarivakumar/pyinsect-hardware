'use strict';

/* PyInsect Data Collector
 * Step 1: capture — a burst of PHOTO_TARGET photos in CAPTURE seconds (default 500 in 8 s) while the
 *         turntable (ESP32-C3 over USB serial) spins continuously and the lighting changes automatically
 * Step 2: review  — gallery of every photo taken
 * Step 3: name    — name the folder and save it as a .zip
 */

const $ = (sel) => document.querySelector(sel);

const PHOTO_TARGET = 500;     // photos per dataset
const DEFAULT_INTERVAL = 8;   // seconds the whole burst takes
const WARMUP_MS = 1500;       // let the camera focus/expose before the burst starts

// Lighting is picked automatically from what the camera supports.
// Camera with a flashlight (phone back camera): flashlight + exposure changes.
const TORCH_LIGHTS = [
  { id: 'room',   label: 'Room light',        torch: false },
  { id: 'flash',  label: 'Flashlight',        torch: true },
  { id: 'dark',   label: 'Darker exposure',   torch: false, exposure: -1.5 },
  { id: 'bright', label: 'Brighter exposure', torch: false, exposure: +1.5 },
];
// No flashlight (laptop webcam / front camera): the screen glows in different colours.
const SCREEN_LIGHTS = [
  { id: 'white', label: 'Screen white', screen: '#ffffff' },
  { id: 'warm',  label: 'Screen warm',  screen: '#ffb867' },
  { id: 'cool',  label: 'Screen cool',  screen: '#8fc2ff' },
  { id: 'room',  label: 'Room light',   screen: '#000000' },
];

const state = {
  photos: [],          // { blob, url, angle, light, lightLabel, time, removed }
  stream: null,
  track: null,
  caps: {},
  abort: false,
  running: false,
  wakeLock: null,
  zipBlob: null,
  zipName: '',
};

let interval = DEFAULT_INTERVAL;
try {
  const saved = +localStorage.getItem('pyinsect-capture-seconds');
  if (saved >= 4 && saved <= 30) interval = saved;
} catch (_) {}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === `screen-${name}`));
  window.scrollTo(0, 0);
}

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Wait `ms`, calling onTick(secondsLeft) and stopping early if the user pressed Stop.
async function wait(ms, onTick) {
  const end = performance.now() + ms;
  while (!state.abort) {
    const left = end - performance.now();
    if (left <= 0) break;
    if (onTick) onTick(Math.ceil(left / 1000));
    await sleep(Math.min(100, left));
  }
}

function fmtDuration(sec) {
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h} h ${m} min`;
  return m ? `${m} min${s ? ` ${s} s` : ''}` : `${s} s`;
}

/* ------------------------------------------------------------------ */
/* Turntable over USB serial (Web Serial API, 115200 baud)             */
/* Each command is one line and gets exactly one reply line.           */
/*   R<deg>  rotate (reply when the move finishes)  -> "OK R"          */
/*   S       stop                                    -> "OK S"         */
/*   C<ms>   set ms per full spin                    -> "OK C"         */
/*   V<us>   set speed (signed)                      -> "OK V"         */
/*   T<us>   set stop trim                           -> "OK T"         */
/*   ?       status                    -> "ms=6000 v=100 t=0"          */
/* Lines starting with "#" are log messages and are ignored.           */
/* ------------------------------------------------------------------ */
class Turntable {
  constructor() {
    this.port = null;
    this.writer = null;
    this.reader = null;
    this.readDone = null;
    this.waiters = [];
    this.info = { ms: 6000, v: 250, t: 0 };
    this.moving = false;
    this.onchange = () => {};
  }

  get connected() { return !!(this.port && this.writer); }

  static get supported() { return 'serial' in navigator; }

  // Reconnect to a port the user already allowed, without showing the picker.
  async autoConnect() {
    if (!Turntable.supported) return false;
    const ports = await navigator.serial.getPorts();
    for (const port of ports) {
      try { await this.connect(port); return true; } catch (_) { await this._cleanup(); }
    }
    return false;
  }

  async connect(port) {
    if (!Turntable.supported) {
      throw new Error('This browser cannot use USB serial. Use Chrome or Edge on a computer.');
    }
    if (this.connected) return;
    port = port || await navigator.serial.requestPort();
    try {
      await port.open({ baudRate: 115200 });
    } catch (err) {
      if (['NetworkError', 'InvalidStateError', 'NotReadableError'].includes(err.name)) {
        throw new Error('Could not open the serial port. Close Arduino Serial Monitor/Plotter, other serial tools, and other PyInsect tabs, then reconnect.');
      }
      throw err;
    }
    this.port = port;
    this.writer = port.writable.getWriter();
    this.readDone = this._readLoop(port);
    this.onchange();

    // The board may still be booting or printing log lines — try a few times.
    await sleep(300);
    let lastErr;
    for (let i = 0; i < 4; i++) {
      try {
        await this.refresh();
        const speedMigrationKey = 'pyinsect-speed-v250-applied';
        let speedMigrationApplied = false;
        try { speedMigrationApplied = localStorage.getItem(speedMigrationKey) === '1'; } catch (_) {}
        if (!speedMigrationApplied) {
          if (this.info.v === 500) {
            await this.command('V250');
            await this.refresh();
          }
          try { localStorage.setItem(speedMigrationKey, '1'); } catch (_) {}
        }
        return;
      } catch (err) { lastErr = err; }
    }
    await this.disconnect();
    throw new Error(`No answer from the turntable on that port. Is the PyInsect firmware uploaded? (${lastErr.message})`);
  }

  async _readLoop(port) {
    let buf = '';
    const decoder = new TextDecoder();
    try {
      this.reader = port.readable.getReader();
      while (true) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.search(/[\r\n]/)) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line && !line.startsWith('#')) this._onMessage(line);
        }
      }
    } catch (_) {
      // device unplugged or port closed
    } finally {
      try { this.reader.releaseLock(); } catch (_) {}
      this.reader = null;
      if (this.port === port) {
        await this._cleanup();
        this.onchange();
      }
    }
  }

  async _cleanup() {
    const port = this.port;
    this.port = null;
    this._failAll(new Error('Turntable disconnected'));
    if (this.writer) { try { this.writer.releaseLock(); } catch (_) {} this.writer = null; }
    if (port) { try { await port.close(); } catch (_) {} }
  }

  async disconnect() {
    const port = this.port;
    if (!port) return;
    this.port = null;          // tell the read loop not to clean up again
    if (this.reader) { try { await this.reader.cancel(); } catch (_) {} }
    await this.readDone;
    this.port = port;
    await this._cleanup();
    this.onchange();
  }

  async refresh() {
    const reply = await this.command('?', 1500);
    for (const part of reply.split(/\s+/)) {
      const [k, v] = part.split('=');
      if (k in this.info && !isNaN(+v)) this.info[k] = +v;
    }
    this.onchange();
    return this.info;
  }

  _onMessage(msg) {
    const w = this.waiters.shift();
    if (!w) return;
    clearTimeout(w.timer);
    if (msg.startsWith('ERR')) w.reject(new Error(`Turntable: ${msg}`));
    else w.resolve(msg);
  }

  _failAll(err) {
    for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); }
  }

  command(cmd, timeoutMs = 4000) {
    if (!this.connected) return Promise.reject(new Error('Turntable not connected'));
    return new Promise((resolve, reject) => {
      const w = { resolve, reject };
      const drop = () => { const i = this.waiters.indexOf(w); if (i >= 0) this.waiters.splice(i, 1); };
      w.timer = setTimeout(() => { drop(); reject(new Error(`Turntable didn't answer "${cmd}"`)); }, timeoutMs);
      this.waiters.push(w);
      this.writer.write(new TextEncoder().encode(cmd + '\n')).catch(err => { drop(); clearTimeout(w.timer); reject(err); });
    });
  }

  // Spin continuously for `ms` milliseconds (reply when it stops).
  spinFor(ms) {
    return this._move(`D${Math.round(ms)}`, ms + 5000);
  }

  rotate(deg) {
    const d = Math.round(deg * 100) / 100;
    return this._move(`R${d}`, (this.info.ms * Math.abs(d)) / 360 + 5000);
  }

  async _move(cmd, timeoutMs) {
    if (this.moving) throw new Error('Turntable is already moving. Wait for it to stop or press Stop.');
    this.moving = true;
    this.onchange();
    try {
      return await this.command(cmd, timeoutMs);
    } finally {
      this.moving = false;
      this.onchange();
    }
  }

  stop() { return this.command('S').catch(() => {}); }
}

const turntable = new Turntable();

function renderTurntable() {
  const on = turntable.connected;
  const s = $('#tt-status');
  s.textContent = on ? 'Connected' : (Turntable.supported ? 'Not connected' : 'Not supported here');
  s.classList.toggle('ok', on);
  $('#tt-connect').textContent = on ? 'Disconnect' : 'Connect turntable';
  $('#tt-connect').disabled = !Turntable.supported || state.running;
  $('#cal-save').disabled = !on || turntable.moving;
  $('#cal-90').disabled = !on || turntable.moving;
  $('#cal-360').disabled = !on || turntable.moving;
  $('#cal-stop').disabled = !on;
  if (on) {
    $('#cal-ms').value = turntable.info.ms;
    $('#cal-speed').value = turntable.info.v;
    $('#cal-trim').value = turntable.info.t;
  }
  $('#run-tt').textContent = on ? 'Turntable connected' : 'No turntable: turn by hand';
  $('#run-tt').classList.toggle('ok', on);
  updateEstimate();
}
turntable.onchange = renderTurntable;

async function connectTurntable() {
  try {
    await turntable.connect();
    toast('Turntable connected');
    return true;
  } catch (err) {
    if (err.name !== 'NotFoundError') toast(err.message, 6000); // NotFoundError = picker closed
    return false;
  }
}

$('#tt-connect').addEventListener('click', () => {
  if (turntable.connected) turntable.disconnect();
  else connectTurntable();
});

$('#cal-save').addEventListener('click', async () => {
  try {
    await turntable.command(`C${Math.round(+$('#cal-ms').value)}`);
    await turntable.command(`V${Math.round(+$('#cal-speed').value)}`);
    await turntable.command(`T${Math.round(+$('#cal-trim').value)}`);
    await turntable.refresh();
    toast('Calibration saved on the turntable');
  } catch (err) { toast(err.message); }
});
$('#cal-90').addEventListener('click', () => turntable.rotate(90).catch(err => toast(err.message)));
$('#cal-360').addEventListener('click', () => turntable.rotate(360).catch(err => toast(err.message)));
$('#cal-stop').addEventListener('click', () => turntable.stop());

if (Turntable.supported) {
  navigator.serial.addEventListener('connect', () => { if (!turntable.connected) turntable.autoConnect(); });
}

/* ------------------------------------------------------------------ */
/* Intro screen                                                        */
/* ------------------------------------------------------------------ */
function updateEstimate() {
  const fps = PHOTO_TARGET / interval;
  $('#estimate').textContent = `${PHOTO_TARGET} photos in ${interval} s · ${fps.toFixed(fps < 100 ? 1 : 0)} photos per second`;
}

$('#interval').value = interval;
$('#interval-out').textContent = `${interval} s`;
$('#interval').addEventListener('input', (e) => {
  interval = +e.target.value;
  $('#interval-out').textContent = `${interval} s`;
  try { localStorage.setItem('pyinsect-capture-seconds', String(interval)); } catch (_) {}
  updateEstimate();
});

/* ------------------------------------------------------------------ */
/* Camera + automatic lighting                                         */
/* ------------------------------------------------------------------ */
async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Camera not available. Open this page over https:// or localhost.');
  }
  stopCamera();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 60 } },
  });
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  const video = $('#video');
  video.srcObject = stream;
  await video.play();
  await sleep(500); // some phones only report flashlight support once frames are flowing
  state.caps = state.track.getCapabilities ? state.track.getCapabilities() : {};
  const facing = (state.track.getSettings && state.track.getSettings().facingMode) || '';
  video.classList.toggle('mirror', facing === 'user');
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  state.stream = null;
  state.track = null;
  $('#video').srcObject = null;
}

function autoLights() {
  if (state.caps.torch) {
    return TORCH_LIGHTS.filter(l => !l.exposure || state.caps.exposureCompensation);
  }
  return SCREEN_LIGHTS;
}

async function applyLight(light) {
  $('#light-overlay').style.background = (light && light.screen) || '#000';
  if (!state.track || (light && light.screen)) return;
  const adv = {};
  if (state.caps.torch) adv.torch = !!(light && light.torch);
  if (state.caps.exposureCompensation) {
    const { min, max } = state.caps.exposureCompensation;
    adv.exposureCompensation = Math.max(min, Math.min(max, (light && light.exposure) || 0));
  }
  if (Object.keys(adv).length) {
    try { await state.track.applyConstraints({ advanced: [adv] }); } catch (_) { /* best effort */ }
  }
}

function grabFrame() {
  const video = $('#video');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not save photo'))), 'image/jpeg', 0.9));
}

async function keepScreenOn(on) {
  try {
    if (on && 'wakeLock' in navigator) state.wakeLock = await navigator.wakeLock.request('screen');
    else if (!on && state.wakeLock) { await state.wakeLock.release(); state.wakeLock = null; }
  } catch (_) {}
}

/* ------------------------------------------------------------------ */
/* Step 1: capture run                                                 */
/* ------------------------------------------------------------------ */
function hud(main, sub = '') {
  $('#hud-main').textContent = main;
  $('#hud-sub').textContent = sub;
}
function hudProgress(done, total) {
  $('#hud-count').textContent = `${done} / ${total}`;
  $('#hud-bar').style.width = `${total ? Math.min(100, (100 * done) / total) : 0}%`;
}

async function runCapture() {
  if (state.running) return;

  // Pressing the button is what lets the browser show the serial-port picker.
  if (!turntable.connected && Turntable.supported) await connectTurntable();
  const useTurntable = turntable.connected;
  if (!useTurntable && !confirm('The turntable is not connected.\n\nTake the photos anyway, without spinning?')) return;

  state.running = true;
  state.abort = false;
  clearPhotos();
  renderTurntable();
  $('#last-shot').hidden = true;
  $('#stop').textContent = 'Stop';
  $('#screen-camera').classList.remove('screenlight');
  show('camera');
  hud('Starting camera…');
  hudProgress(0, PHOTO_TARGET);
  await keepScreenOn(true);

  let spun = 0;          // degrees the turntable turned during the burst
  let spin = null;       // promise for the continuous spin
  try {
    await startCamera();
    const lights = autoLights();
    $('#screen-camera').classList.toggle('screenlight', !!lights[0].screen);
    await applyLight(lights[0]);
    await wait(WARMUP_MS, () => hud('Get ready…', `${PHOTO_TARGET} photos in ${interval} seconds`));
    if (state.abort) throw new Error('stopped');

    const video = $('#video');
    const durationMs = interval * 1000;
    const gapMs = durationMs / PHOTO_TARGET;        // 16 ms for 500 photos in 8 s
    const lightMs = durationMs / lights.length;     // each lighting gets an equal slice of the burst

    // Count how many different frames the camera really delivers.
    let frames = 0, counting = true;
    if (video.requestVideoFrameCallback) {
      const onFrame = () => { if (counting) { frames++; video.requestVideoFrameCallback(onFrame); } };
      video.requestVideoFrameCallback(onFrame);
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    const encoding = [];

    if (useTurntable) spin = turntable.spinFor(durationMs);
    const t0 = performance.now();
    let lightIdx = 0;

    for (let i = 0; i < PHOTO_TARGET && !state.abort; i++) {
      const due = t0 + i * gapMs;
      const early = due - performance.now();
      if (early > 1) await sleep(early);

      const elapsed = performance.now() - t0;
      const li = Math.min(lights.length - 1, Math.floor(elapsed / lightMs));
      if (li !== lightIdx) { lightIdx = li; applyLight(lights[li]); } // don't wait, keep the burst on time
      const light = lights[lightIdx];

      ctx.drawImage(video, 0, 0);
      const angle = useTurntable ? Math.round(((elapsed / turntable.info.ms) * 360 % 360) * 10) / 10 : 0;
      const photo = { blob: null, url: '', angle, light: light.id, lightLabel: light.label, time: new Date(), removed: false };
      state.photos.push(photo);
      // toBlob copies the canvas now and encodes in the background, so the next photo isn't delayed.
      encoding.push(new Promise(res => canvas.toBlob(b => {
        if (b) { photo.blob = b; photo.url = URL.createObjectURL(b); }
        res();
      }, 'image/jpeg', 0.85)));

      if (i % 8 === 0) {
        hudProgress(i + 1, PHOTO_TARGET);
        hud(`${Math.max(0, (durationMs - elapsed) / 1000).toFixed(1)} s`, `${light.label} · ${i + 1} photos`);
      }
      if (i % 25 === 0) {
        const n = encoding.length - 1;
        encoding[n].then(() => { if (photo.url) { $('#last-shot').src = photo.url; $('#last-shot').hidden = false; } });
      }
    }
    const burstMs = performance.now() - t0;
    counting = false;
    hudProgress(state.photos.length, PHOTO_TARGET);
    hud('Saving photos…', `${state.photos.length} photos in ${(burstMs / 1000).toFixed(1)} s`);
    applyLight(null);

    await Promise.all(encoding);
    state.photos = state.photos.filter(p => p.blob);
    state.cameraFrames = video.requestVideoFrameCallback ? frames : null;
    state.burstMs = burstMs;

    if (spin) {
      hud('Saving photos…', 'Turntable finishing its spin');
      await spin;
      spun = (durationMs / turntable.info.ms) * 360;
      const back = Math.ceil(spun / 360 - 1e-6) * 360 - spun;
      if (!state.abort && back > 0.5) {
        hud('Returning to start…');
        await turntable.rotate(back);
      }
    }
  } catch (err) {
    if (!state.abort) toast(err.message || String(err), 6000);
  } finally {
    if (spin) spin.catch(() => {});
    if (useTurntable && state.abort) await turntable.stop();
    await applyLight(null);
    stopCamera();
    await keepScreenOn(false);
    state.running = false;
    renderTurntable();
  }

  if (state.photos.length) {
    renderGallery();
    show('gallery');
  } else {
    show('intro');
  }
}

$('#capture').addEventListener('click', runCapture);
$('#stop').addEventListener('click', () => {
  if (state.photos.length && !confirm(`Stop now? You have ${state.photos.length} photos.`)) return;
  state.abort = true;
  $('#stop').textContent = 'Stopping…';
  if (turntable.connected) turntable.stop();
});

/* ------------------------------------------------------------------ */
/* Step 2: gallery                                                     */
/* ------------------------------------------------------------------ */
function keptPhotos() { return state.photos.filter(p => !p.removed); }

function renderGallery() {
  const g = $('#gallery');
  g.innerHTML = '';
  const frag = document.createDocumentFragment();
  state.photos.forEach((p, i) => {
    const fig = document.createElement('button');
    fig.className = 'thumb' + (p.removed ? ' removed' : '');
    fig.type = 'button';
    fig.setAttribute('aria-pressed', String(p.removed));
    fig.setAttribute('aria-label', `Photo ${i + 1}, ${p.angle} degrees, ${p.lightLabel}. Tap to ${p.removed ? 'keep' : 'remove'}.`);
    const img = document.createElement('img');
    img.src = p.url;
    img.loading = 'lazy';
    img.alt = '';
    const cap = document.createElement('figcaption');
    cap.textContent = `${p.angle}° · ${p.lightLabel}`;
    fig.append(img, cap);
    fig.addEventListener('click', () => {
      p.removed = !p.removed;
      fig.classList.toggle('removed', p.removed);
      fig.setAttribute('aria-pressed', String(p.removed));
      updateGalleryCount();
    });
    frag.append(fig);
  });
  g.append(frag);
  updateGalleryCount();
}

function updateGalleryCount() {
  const removed = state.photos.length - keptPhotos().length;
  let text = `${state.photos.length} photos taken`;
  if (state.burstMs) text += ` in ${(state.burstMs / 1000).toFixed(1)} s`;
  if (state.cameraFrames && state.cameraFrames < state.photos.length) {
    const fps = Math.round(state.cameraFrames / (state.burstMs / 1000));
    text += `. Your camera ran at about ${fps} frames per second, so about ${state.cameraFrames} of them are different and the rest are repeats`;
  }
  text += removed ? ` · ${removed} will be removed` : ' · tap a photo to remove it';
  $('#gallery-count').textContent = text;
  $('#gallery-next').disabled = keptPhotos().length === 0;
}

function clearPhotos() {
  state.photos.forEach(p => URL.revokeObjectURL(p.url));
  state.photos = [];
  state.zipBlob = null;
  state.burstMs = 0;
  state.cameraFrames = null;
}

$('#gallery-restart').addEventListener('click', () => {
  if (confirm('Throw away these photos and start over?')) { clearPhotos(); show('intro'); }
});
$('#gallery-next').addEventListener('click', () => {
  updateNamePreview();
  show('name');
  $('#folder-name').focus();
});

/* ------------------------------------------------------------------ */
/* Step 3: name + save                                                 */
/* ------------------------------------------------------------------ */
function cleanName(raw) {
  return raw.trim().replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
}

function fileNameFor(folder, p, i) {
  const n = String(i + 1).padStart(3, '0');
  const deg = p.angle.toFixed(1).replace('.', 'p').padStart(5, '0');
  return `${folder}_${n}_${deg}deg_${p.light}.jpg`;
}

function updateNamePreview() {
  const folder = cleanName($('#folder-name').value);
  const kept = keptPhotos();
  $('#save-zip').disabled = !folder;
  $('#share-zip').disabled = !folder;
  $('#save-status').textContent = '';
  $('#name-preview').textContent = folder && kept.length
    ? `${folder}.zip → ${folder}/${fileNameFor(folder, kept[0], 0)} … (${kept.length} photos + labels.csv)`
    : `${kept.length} photos ready`;
  state.zipBlob = null;
}
$('#folder-name').addEventListener('input', updateNamePreview);

async function buildZip() {
  const folder = cleanName($('#folder-name').value);
  if (state.zipBlob && state.zipName === folder) return { blob: state.zipBlob, folder };
  if (typeof JSZip === 'undefined') throw new Error('Zip library failed to load. Check your internet connection.');

  const zip = new JSZip();
  const dir = zip.folder(folder);
  const rows = [['file', 'insect', 'angle_deg', 'lighting', 'captured_at']];
  keptPhotos().forEach((p, i) => {
    const name = fileNameFor(folder, p, i);
    dir.file(name, p.blob);
    rows.push([name, folder, p.angle, p.light, p.time.toISOString()]);
  });
  dir.file('labels.csv', rows.map(r => r.join(',')).join('\n') + '\n');

  $('#save-status').textContent = 'Packing photos…';
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' }, (m) => {
    $('#save-status').textContent = `Packing photos… ${Math.round(m.percent)}%`;
  });
  state.zipBlob = blob;
  state.zipName = folder;
  return { blob, folder };
}

$('#save-zip').addEventListener('click', async () => {
  try {
    const { blob, folder } = await buildZip();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${folder}.zip`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    $('#save-status').textContent = `Saved ${folder}.zip (${(blob.size / 1e6).toFixed(1)} MB) to Downloads.`;
  } catch (err) {
    $('#save-status').textContent = err.message;
  }
});

if (navigator.canShare && navigator.canShare({ files: [new File([''], 'x.zip', { type: 'application/zip' })] })) {
  $('#share-zip').hidden = false;
  $('#share-zip').addEventListener('click', async () => {
    try {
      const { blob, folder } = await buildZip();
      const file = new File([blob], `${folder}.zip`, { type: 'application/zip' });
      await navigator.share({ files: [file], title: `${folder} dataset` });
      $('#save-status').textContent = '';
    } catch (err) {
      if (err.name !== 'AbortError') $('#save-status').textContent = err.message;
    }
  });
}

$('#name-back').addEventListener('click', () => { renderGallery(); show('gallery'); });
$('#name-new').addEventListener('click', () => {
  if (!state.zipBlob && !confirm("You haven't saved this folder yet. Start a new insect anyway?")) return;
  clearPhotos();
  $('#folder-name').value = '';
  show('intro');
});

/* ------------------------------------------------------------------ */
renderTurntable();
turntable.autoConnect();
