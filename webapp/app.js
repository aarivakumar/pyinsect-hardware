'use strict';

/* PyInsect Data Collector
 * Step 1: capture — a burst of photoTarget photos in CAPTURE seconds (default 500 in 8 s) while the
 *         turntable (ESP32-C3 over USB serial) spins continuously and the lighting changes automatically
 * Step 2: review  — gallery of every photo taken
 * Step 3: name    — name the folder and save it as a .zip
 */

const $ = (sel) => document.querySelector(sel);

const DEFAULT_PHOTOS = 500;   // photos per dataset (the Photos slider changes it, 50-1000)
const DEFAULT_INTERVAL = 8;   // seconds the whole burst takes
const MAX_ZOOM = 4;           // highest zoom on the slider (more when the camera has real zoom, up to 8)
const MAX_ENCODING = 24;      // photos allowed to wait for JPEG encoding at once (limits phone memory)
const WARMUP_MS = 1500;       // let the camera focus/expose before the burst starts

// Lighting changes automatically through many levels during the burst.
// ev = exposure compensation (hardware, if the camera supports it); soft = software fallback
// (negative = darker, positive = brighter) used when the camera has no exposure control.
const CAMERA_LIGHTS = [
  { id: 'normal',      label: 'Normal',          ev: 0,    soft: 0 },
  { id: 'dim',         label: 'Dim',             ev: -1,   soft: -0.35 },
  { id: 'dark',        label: 'Dark',            ev: -2,   soft: -0.6 },
  { id: 'bright',      label: 'Bright',          ev: 1,    soft: 0.25 },
  { id: 'verybright',  label: 'Very bright',     ev: 2,    soft: 0.5 },
];
// The flashlight strobes on, off, on, off... through the whole burst, on top of the levels above,
// so every angle and every level gets photos both with and without the flashlight.
const STROBE_MS = 400;        // flashlight stays on this long, then off this long
// No flashlight (laptop webcam / front camera): the screen glows in different colours and levels.
const SCREEN_LIGHTS = [
  { id: 'white',  label: 'Screen white',  screen: '#ffffff' },
  { id: 'warm',   label: 'Screen warm',   screen: '#ffb867' },
  { id: 'cool',   label: 'Screen cool',   screen: '#8fc2ff' },
  { id: 'dim',    label: 'Screen dim',    screen: '#707070' },
  { id: 'dark',   label: 'Screen dark',   screen: '#242424' },
  { id: 'room',   label: 'Room light',    screen: '#000000' },
];
const LIGHT_SETTLE_MS = 150;  // camera needs a moment before a new light shows up in frames

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
let photoTarget = DEFAULT_PHOTOS;
let zoom = 1;
try {
  const saved = +localStorage.getItem('pyinsect-capture-seconds');
  if (saved >= 4 && saved <= 30) interval = saved;
  const count = +localStorage.getItem('pyinsect-photo-count');
  if (count >= 50 && count <= 1000) photoTarget = count;
  const z = +localStorage.getItem('pyinsect-zoom');
  if (z >= 1 && z <= 8) zoom = z;
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
/* ------------------------------------------------------------------ */
/* WebUSB serial: lets Chrome on Android phones talk to the ESP32.     */
/* Phones have no Web Serial, so this looks like a serial port         */
/* (open / readable / writable / close) but uses USB CDC directly.     */
/* ------------------------------------------------------------------ */
class UsbSerialPort {
  constructor(device) {
    this.device = device;
    this.readable = null;
    this.writable = null;
    this.ctrlIf = null; this.dataIf = null; this.inEp = null; this.outEp = null;
    this.closed = false;
  }

  async open({ baudRate = 115200 } = {}) {
    const d = this.device;
    await d.open();
    if (!d.configuration) await d.selectConfiguration(1);
    // Find the CDC data interface (class 0x0A) with a bulk IN and bulk OUT endpoint.
    for (const iface of d.configuration.interfaces) {
      const alt = iface.alternates.find(a => a.interfaceClass === 0x0a);
      if (!alt) continue;
      const inEp = alt.endpoints.find(e => e.direction === 'in' && e.type === 'bulk');
      const outEp = alt.endpoints.find(e => e.direction === 'out' && e.type === 'bulk');
      if (inEp && outEp) { this.dataIf = iface.interfaceNumber; this.inEp = inEp.endpointNumber; this.outEp = outEp.endpointNumber; }
    }
    const comm = d.configuration.interfaces.find(i => i.alternates.some(a => a.interfaceClass === 0x02));
    this.ctrlIf = comm ? comm.interfaceNumber : null;
    if (this.dataIf === null) {
      await d.close().catch(() => {});
      const e = new Error('That USB device is not the ESP32 turntable. Pick the entry for the ESP32 (often "USB JTAG/serial debug unit").'); e.name = 'NetworkError'; throw e;
    }
    try {
      if (this.ctrlIf !== null) await d.claimInterface(this.ctrlIf);
      await d.claimInterface(this.dataIf);
    } catch (err) {
      await d.close().catch(() => {});
      const e = new Error(err.message); e.name = 'NetworkError'; throw e;
    }
    if (this.ctrlIf !== null) {
      // Line coding (baud rate, 8N1) and DTR+RTS on, like a normal serial terminal.
      const lc = new DataView(new ArrayBuffer(7));
      lc.setUint32(0, baudRate, true); lc.setUint8(4, 0); lc.setUint8(5, 0); lc.setUint8(6, 8);
      try {
        await d.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: this.ctrlIf }, lc.buffer);
        await d.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: 0x03, index: this.ctrlIf });
      } catch (_) { /* some boards don't need it */ }
    }
    this.closed = false;
    this.readable = new ReadableStream({
      pull: async (controller) => {
        try {
          const r = await d.transferIn(this.inEp, 512);
          if (r.status === 'stall') await d.clearHalt('in', this.inEp);
          else if (r.data && r.data.byteLength) controller.enqueue(new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength));
        } catch (err) {
          if (this.closed) controller.close(); else controller.error(err);
        }
      },
      cancel: () => { this.closed = true; },
    });
    this.writable = new WritableStream({
      write: async (chunk) => { await d.transferOut(this.outEp, chunk); },
    });
  }

  async close() {
    this.closed = true;
    const d = this.device;
    try { if (this.ctrlIf !== null) await d.controlTransferOut({ requestType: 'class', recipient: 'interface', request: 0x22, value: 0, index: this.ctrlIf }); } catch (_) {}
    try { await d.releaseInterface(this.dataIf); } catch (_) {}
    try { if (this.ctrlIf !== null) await d.releaseInterface(this.ctrlIf); } catch (_) {}
    try { await d.close(); } catch (_) {}
  }
}

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

  // Web Serial on computers; WebUSB on Android phones. Newer Chrome on Android
  // has navigator.serial, but its picker does not list USB boards like the ESP32,
  // so Android always uses WebUSB when it is available.
  static get supported() { return 'serial' in navigator || 'usb' in navigator; }
  static get useWebSerial() {
    const android = /Android/i.test(navigator.userAgent);
    return 'serial' in navigator && !(android && 'usb' in navigator);
  }

  // Reconnect to a port the user already allowed, without showing the picker.
  async autoConnect() {
    if (!Turntable.supported) return false;
    let ports = [];
    try {
      if (Turntable.useWebSerial) ports = await navigator.serial.getPorts();
      else ports = (await navigator.usb.getDevices()).map(d => new UsbSerialPort(d));
    } catch (_) {}
    for (const port of ports) {
      try { await this.connect(port); return true; } catch (_) { await this._cleanup(); }
    }
    return false;
  }

  async connect(port) {
    if (!Turntable.supported) {
      throw new Error('This browser cannot use USB. Use Chrome on a computer or an Android phone.');
    }
    if (this.connected) return;
    if (!port) {
      if (Turntable.useWebSerial) port = await navigator.serial.requestPort();
      else port = new UsbSerialPort(await navigator.usb.requestDevice({ filters: [] }));
    }
    try {
      await port.open({ baudRate: 115200 });
    } catch (err) {
      if (['NetworkError', 'InvalidStateError', 'NotReadableError'].includes(err.name)) {
        throw new Error('Could not open the serial port. Close Arduino Serial Monitor/Plotter, other serial tools, and other PyInsect tabs, then reconnect. On a phone, use a USB-C to USB-C cable and unplug/replug the board if it was already connected.');
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
  const usbApi = Turntable.useWebSerial ? navigator.serial : navigator.usb;
  usbApi.addEventListener('connect', () => { if (!turntable.connected) turntable.autoConnect(); });
}

/* ------------------------------------------------------------------ */
/* Intro screen                                                        */
/* ------------------------------------------------------------------ */
function updateEstimate() {
  const fps = photoTarget / interval;
  let text = `${photoTarget} photos in ${interval} s · ${fps.toFixed(fps < 100 ? 1 : 0)} photos per second`;
  // The camera is asked for 60 frames per second; warn only when well above that (not on the default 62.5).
  if (fps > 75) text += '. Some photos will be the same, because that is faster than the camera. Use fewer photos or more time.';
  $('#estimate').textContent = text;
}

$('#count').value = photoTarget;
$('#count-out').textContent = String(photoTarget);
$('#count').addEventListener('input', (e) => {
  photoTarget = +e.target.value;
  $('#count-out').textContent = String(photoTarget);
  try { localStorage.setItem('pyinsect-photo-count', String(photoTarget)); } catch (_) {}
  updateEstimate();
});

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
    // zoom: true asks Chrome to expose the camera's real zoom, when it has one.
    video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 960 }, frameRate: { ideal: 60 }, zoom: true },
  });
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  state.hwZoomBroken = false;
  const video = $('#video');
  video.srcObject = stream;
  await video.play();
  const facing = (state.track.getSettings && state.track.getSettings().facingMode) || '';
  state.facingUser = facing === 'user';
  // Some phones only report flashlight support once frames are flowing, so look for up to 1.5 s.
  for (let i = 0; i < 6; i++) {
    await sleep(250);
    state.caps = state.track.getCapabilities ? state.track.getCapabilities() : {};
    if (state.caps.torch) break;
  }
  video.classList.toggle('mirror', state.facingUser);
}

function stopCamera() {
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  state.stream = null;
  state.track = null;
  $('#video').srcObject = null;
}

/* Zoom: real camera zoom when the camera has it (sharper), otherwise a digital zoom that keeps
 * only the centre of each frame. Either way the saved photos show just the zoomed-in part.
 * `zoom` is a multiple of the camera's widest view. Phones report their range as a ratio (1-8),
 * desktop webcams often in raw units (e.g. 100-500), so the real value is relative to the minimum. */
function hwRange() {
  const z = state.caps.zoom;
  if (state.hwZoomBroken || !z || !(z.min > 0) || z.max / z.min < 2) return null;   // less than 2× isn't worth it
  return z;
}
function hwZoom() {
  const z = hwRange();
  if (!z) return null;
  let v = Math.max(z.min, Math.min(z.max, z.min * zoom));
  if (z.step > 0) v = Math.min(z.max, z.min + Math.round((v - z.min) / z.step) * z.step);
  return v;
}
function maxZoom() { const z = hwRange(); return z ? Math.min(8, z.max / z.min) : MAX_ZOOM; }
function digitalZoom() { return hwZoom() === null ? zoom : 1; }

// Sizes the preview so it shows exactly what the photos keep: a box with the photo's shape, as big
// as fits in the free space above the controls panel (beside it in landscape) so the bug in the
// middle is never hidden under the panel. With digital zoom the video inside the box is drawn
// `d` times bigger and centred, so the box shows just the centre part the photos crop to.
function layoutPreview() {
  const cam = $('#screen-camera'), box = $('#preview'), video = $('#video');
  const r = $('.panel.run').getBoundingClientRect(), c = cam.getBoundingClientRect();
  if (!c.width || !c.height) return;   // camera screen not showing
  const side = r.width < c.width * 0.9;
  const ph = side ? 0 : Math.max(0, c.bottom - r.top), pw = side ? Math.max(0, c.right - r.left) : 0;
  cam.style.setProperty('--panel-h', `${ph}px`);
  cam.style.setProperty('--panel-w', `${pw}px`);
  const a = video.videoWidth > 16 && video.videoHeight > 16 ? video.videoWidth / video.videoHeight : 4 / 3;
  let w, h;
  if (cam.classList.contains('screenlight')) {   // small preview in the corner; CSS places it
    w = c.width * 0.3; h = w / a;
    box.style.left = box.style.top = '';
  } else {
    const W = c.width - pw, H = c.height - ph;
    if (W / H > a) { h = H; w = H * a; } else { w = W; h = W / a; }
    box.style.left = `${(W - w) / 2}px`;
    box.style.top = `${(H - h) / 2}px`;
  }
  box.style.width = `${w}px`;
  box.style.height = `${h}px`;
  const d = digitalZoom();
  video.style.width = `${w * d}px`;
  video.style.height = `${h * d}px`;
  video.style.left = `${(w - w * d) / 2}px`;
  video.style.top = `${(h - h * d) / 2}px`;
}
if (window.ResizeObserver) new ResizeObserver(layoutPreview).observe($('.panel.run'));
window.addEventListener('resize', layoutPreview);
$('#video').addEventListener('resize', layoutPreview);   // the camera's picture size became known or changed

// The part of the camera frame the photos keep: { sx, sy, sw, sh } in video pixels.
function cropRect(video) {
  const d = digitalZoom();
  const sw = Math.round(video.videoWidth / d), sh = Math.round(video.videoHeight / d);
  return { sx: Math.round((video.videoWidth - sw) / 2), sy: Math.round((video.videoHeight - sh) / 2), sw, sh };
}

let zoomSeq = 0;
async function setZoom(z) {
  zoom = z;
  const seq = ++zoomSeq;
  $('#zoom-out').textContent = `${z.toFixed(1)}×`;
  try { localStorage.setItem('pyinsect-zoom', String(z)); } catch (_) {}
  layoutPreview();   // digital zoom: the preview shows the same centre part the photos keep
  const want = hwZoom();
  if (want === null || !state.track) return;
  try { await state.track.applyConstraints({ advanced: [{ zoom: want }] }); } catch (_) { /* best effort */ }
  if (seq !== zoomSeq || !state.track) return;   // the slider has moved on; only the latest request is checked
  // Some cameras list a zoom range but ignore it. Then use digital zoom for the rest of this session.
  const got = state.track.getSettings ? state.track.getSettings().zoom : undefined;
  const min = state.caps.zoom.min;
  if (want > min * 1.2 && typeof got === 'number' && Math.abs(got - min) < (want - min) * 0.1) {
    state.hwZoomBroken = true;
    $('#zoom').max = maxZoom();
    const z2 = Math.min(zoom, maxZoom());
    $('#zoom').value = z2;
    setZoom(z2);
  }
}

// Shows the zoom slider over the live camera and waits for Start (or Cancel).
function frameBug() {
  const cam = $('#screen-camera'), slider = $('#zoom');
  slider.max = maxZoom();
  zoom = Math.max(1, Math.min(zoom, +slider.max));
  slider.value = zoom;
  setZoom(zoom);
  slider.oninput = () => setZoom(+slider.value);
  $('#frame-controls').hidden = false;
  $('#frame-guide').hidden = cam.classList.contains('screenlight');
  cam.classList.add('framing');
  $('#stop').textContent = 'Cancel';
  hud('Zoom in on the bug', 'Put the bug in the ring, move the slider until it fills the picture, then press Start.');
  layoutPreview();
  return new Promise(resolve => {
    const done = () => {
      clearInterval(watch);
      $('#frame-controls').hidden = true;
      $('#frame-guide').hidden = true;
      cam.classList.remove('framing');
      if (!state.abort) $('#stop').textContent = 'Stop';
      layoutPreview();
      resolve();
    };
    const watch = setInterval(() => { if (state.abort) done(); }, 100);
    $('#start-burst').onclick = done;
  });
}

// Gives the browser a turn without waiting a whole timer tick (setTimeout(0) can take 4 ms or more).
function yieldNow() {
  return new Promise(resolve => { const c = new MessageChannel(); c.port1.onmessage = () => resolve(); c.port2.postMessage(0); });
}

function autoLights() {
  // Phones often report the flashlight only after frames start flowing — caps are re-read in startCamera.
  return state.caps.torch || state.caps.exposureCompensation || !state.facingUser ? CAMERA_LIGHTS : SCREEN_LIGHTS;
}

// The id and label saved with a photo, e.g. "dim_flash" / "Dim + flashlight".
function shotLight(light, torch) {
  return torch ? { id: `${light.id}_flash`, label: `${light.label} + flashlight` } : { id: light.id, label: light.label };
}

// Resolves once the hardware has been told to change. The software part is applied per photo.
async function applyLight(light, torch = false) {
  $('#light-overlay').style.background = (light && light.screen) || '#000';
  if (!state.track || (light && light.screen)) return;
  const adv = {};
  if (state.caps.torch) adv.torch = !!torch;
  if (hwZoom() !== null) adv.zoom = hwZoom();   // sent every time so a light change can't undo the zoom
  if (state.caps.exposureCompensation) {
    const { min, max } = state.caps.exposureCompensation;
    adv.exposureCompensation = Math.max(min, Math.min(max, (light && light.ev) || 0));
  }
  if (Object.keys(adv).length) {
    try { await state.track.applyConstraints({ advanced: [adv] }); } catch (_) { /* best effort */ }
  }
}

// Software brightness, only for cameras with no exposure control, so the dataset still has dark/bright photos.
function softLevel(light) {
  return state.caps.exposureCompensation || light.screen ? 0 : (light.soft || 0);
}
function applySoft(ctx, w, h, level) {
  if (!level) return;
  ctx.fillStyle = level < 0 ? `rgba(0,0,0,${-level})` : `rgba(255,255,255,${level})`;
  ctx.fillRect(0, 0, w, h);
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
    if (on && state.wakeLock && !state.wakeLock.released) return;   // already held
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
  let useTurntable = turntable.connected;
  if (!useTurntable && !confirm('The turntable is not connected.\n\nTake the photos anyway, without spinning?')) return;

  try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); } catch (_) {}
  state.running = true;
  state.abort = false;
  clearPhotos();
  renderTurntable();
  $('#last-shot').hidden = true;
  $('#stop').textContent = 'Stop';
  $('#screen-camera').classList.remove('screenlight', 'framing');
  $('#frame-controls').hidden = true;
  $('#frame-guide').hidden = true;
  show('camera');
  hud('Starting camera…');
  hudProgress(0, photoTarget);
  await keepScreenOn(true);

  let spun = 0;          // degrees the turntable turned during the burst
  let spin = null;       // promise for the continuous spin
  let lighting = null;   // promise for the loop that changes the light and strobes the flashlight
  let lightingDone = false;
  try {
    await startCamera();
    const lights = autoLights();
    $('#screen-camera').classList.toggle('screenlight', !!lights[0].screen);
    layoutPreview();
    await applyLight(lights[0]);
    await frameBug();
    if (state.abort) throw new Error('stopped');
    // Framing can take a while: the screen may have locked (dropping the wake lock) or the
    // turntable cable may have come loose, so check both again before the burst.
    await keepScreenOn(true);
    if (useTurntable && !turntable.connected) {
      await turntable.autoConnect();
      if (!turntable.connected) {
        if (!confirm('The turntable got disconnected.\n\nTake the photos anyway, without spinning?')) { state.abort = true; throw new Error('stopped'); }
        useTurntable = false;
      }
    }
    await wait(WARMUP_MS, () => hud('Get ready…', `${photoTarget} photos in ${interval} seconds`));
    if (state.abort) throw new Error('stopped');

    const video = $('#video');
    // The camera can briefly report a tiny placeholder size (2×2) before real frames arrive.
    // Wait for the real size, or every photo would be a few pixels.
    for (let t = 0; video.videoWidth <= 16 && t < 60 && !state.abort; t++) await sleep(50);
    if (state.abort) throw new Error('stopped');
    if (video.videoWidth <= 16) throw new Error('The camera did not start properly. Please try again.');
    const durationMs = interval * 1000;
    const gapMs = durationMs / photoTarget;        // 16 ms for 500 photos in 8 s
    const lightMs = durationMs / lights.length;     // each lighting gets an equal slice of the burst
    const strobe = !!state.caps.torch && !lights[0].screen;
    let active = { light: lights[0], torch: false }; // what the camera is really showing right now

    // Count how many different frames the camera really delivers.
    let frames = 0, counting = true;
    if (video.requestVideoFrameCallback) {
      const onFrame = () => { if (counting) { frames++; video.requestVideoFrameCallback(onFrame); } };
      video.requestVideoFrameCallback(onFrame);
    }

    // Photos keep only the zoomed-in part of the frame (all of it with real camera zoom).
    const crop = cropRect(video);
    const canvas = document.createElement('canvas');
    canvas.width = crop.sw;
    canvas.height = crop.sh;
    const ctx = canvas.getContext('2d');
    const encoding = [];

    if (useTurntable) spin = turntable.spinFor(durationMs);
    const t0 = performance.now();

    // Runs beside the photo loop so the burst stays on time. One change at a time: the camera is told
    // the new level and flashlight state, given LIGHT_SETTLE_MS to show it, and only then are photos
    // labelled with it.
    lighting = (async () => {
      let cur = active;
      while (!lightingDone && !state.abort) {
        const elapsed = performance.now() - t0;
        const want = {
          light: lights[Math.min(lights.length - 1, Math.floor(elapsed / lightMs))],
          torch: strobe && Math.floor(elapsed / STROBE_MS) % 2 === 0,
        };
        if (want.light === cur.light && want.torch === cur.torch) { await sleep(5); continue; }
        await applyLight(want.light, want.torch);
        await sleep(LIGHT_SETTLE_MS);
        cur = active = want;
      }
    })();

    let encodingNow = 0;   // photos still being turned into JPEGs
    for (let i = 0; i < photoTarget && !state.abort; i++) {
      const due = t0 + i * gapMs;
      const early = due - performance.now();
      // Always give the browser a turn, even when behind schedule, so the flashlight strobe,
      // the on-screen counter and the JPEG encoding keep running.
      await (early > 1 ? sleep(early) : yieldNow());
      // Too many photos waiting to be encoded uses a lot of phone memory: let them catch up.
      while (encodingNow >= MAX_ENCODING && !state.abort) await sleep(2);
      // The turntable spins for exactly the burst time. If the phone can't keep up, stop on time
      // with fewer photos rather than take photos after the spin with wrong angles.
      if (performance.now() - t0 > durationMs) break;

      const elapsed = performance.now() - t0;
      const { light, torch } = active;
      const shot = shotLight(light, torch);

      ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, crop.sw, crop.sh);
      applySoft(ctx, canvas.width, canvas.height, softLevel(light));
      const angle = useTurntable ? Math.round(((elapsed / turntable.info.ms) * 360 % 360) * 10) / 10 : 0;
      const photo = { blob: null, url: '', angle, light: shot.id, lightLabel: shot.label, time: new Date(), removed: false };
      state.photos.push(photo);
      // toBlob copies the canvas now and encodes in the background, so the next photo isn't delayed.
      encodingNow++;
      encoding.push(new Promise(res => canvas.toBlob(b => {
        encodingNow--;
        if (b) { photo.blob = b; photo.url = URL.createObjectURL(b); }
        res();
      }, 'image/jpeg', 0.85)));

      if (i % 8 === 0) {
        hudProgress(i + 1, photoTarget);
        hud(`${Math.max(0, (durationMs - elapsed) / 1000).toFixed(1)} s`, `${shot.label} · ${i + 1} photos`);
      }
      if (i % 25 === 0) {
        const n = encoding.length - 1;
        encoding[n].then(() => { if (photo.url) { $('#last-shot').src = photo.url; $('#last-shot').hidden = false; } });
      }
    }
    const burstMs = performance.now() - t0;
    counting = false;
    hudProgress(state.photos.length, photoTarget);
    hud('Saving photos…', `${state.photos.length} photos in ${(burstMs / 1000).toFixed(1)} s`);
    lightingDone = true;
    await lighting;
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
    lightingDone = true;
    if (lighting) await lighting.catch(() => {});
    await applyLight(null);   // flashlight off, after the strobe loop has stopped so it can't turn it back on
    stopCamera();
    try { if (document.fullscreenElement) await document.exitFullscreen(); } catch (_) {}
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

// width = digits in the photo number, so 1000 photos are numbered 0001...1000 and still sort in order.
function fileNameFor(folder, p, i, width = Math.max(3, String(keptPhotos().length).length)) {
  const n = String(i + 1).padStart(width, '0');
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
  const kept = keptPhotos();
  const width = Math.max(3, String(kept.length).length);
  kept.forEach((p, i) => {
    const name = fileNameFor(folder, p, i, width);
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
