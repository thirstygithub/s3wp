import * as store from './host.js?v=9798389b2cfa';
import * as net from './net.js?v=9798389b2cfa';
import { createFrontend } from './frontend.js?v=9798389b2cfa';
import { installTouchControls, touchPad } from './touch.js?v=9798389b2cfa';

const BUILD = new URL(import.meta.url).search;

const $ = (id) => document.getElementById(id);
let frontend = null;
const params = new URLSearchParams(location.search);

const loading = $('loading');
const fill = $('load-fill');
const loadLabel = $('load-label');

const gameShown = () => document.body.classList.contains('in-game');

function showStage(label) {
  if (gameShown()) return;
  loading.hidden = false;
  fill.classList.add('indeterminate');
  loadLabel.textContent = label;
}

function showProgress(fraction, label) {
  if (gameShown()) return;
  loading.hidden = false;
  fill.classList.remove('indeterminate');
  fill.style.width = `${Math.max(0, Math.min(1, fraction)) * 100}%`;
  loadLabel.textContent = label;
}

function fail(message, heading) {
  loading.hidden = true;
  document.body.classList.remove('in-game');
  stopTips();
  console.error(message);
  if (frontend) frontend.fail(message, heading);
}

const engineRunning = () => {
  const canvas = $('skate-canvas');
  return canvas.width > 320 && canvas.height > 240;
};

let watchdog = 0;

const TIPS = [
  'Pull the right stick back, then flick it forward to ollie. Flick it the other way for a nollie.',
  'Flick the right stick off to a side on the way up to kickflip or heelflip.',
  'Hold a bumper in the air to grab: left bumper is your left hand, right bumper your right.',
  'Pushing harder means more speed, and more speed means bigger gaps. Push with A (Space on keyboard).',
  'No controller? WASD steers and the arrow keys are your right stick. Flick them like a thumbstick.',
  'Press Start (Esc) and go to ONLINE to host a session, or join a friend with their code.',
  'Port Carverton is big. Choose World in the Freeskate menu to go somewhere else.',
  'Bailing is part of skating. Hardcore difficulty makes every landing count.',
  'Land on your bolts. Keep the board level before you touch down.',
  'Ollie into a rail or ledge and hold the stick to keep the grind going.',
  'This is a fan game, not an EA release. Questions or bugs: root@aaddpp.lol',
];
const tipBox = $('load-tip');
let tipTimer = 0;
let tipIndex = Math.floor(Math.random() * TIPS.length);

function nextTip() {
  tipBox.classList.add('out');
  setTimeout(() => {
    tipIndex = (tipIndex + 1) % TIPS.length;
    tipBox.textContent = TIPS[tipIndex];
    tipBox.classList.remove('out');
  }, 350);
}

function startTips() {
  tipBox.textContent = TIPS[tipIndex];
  if (!tipTimer) tipTimer = setInterval(nextTip, 7000);
}

function stopTips() {
  if (tipTimer) clearInterval(tipTimer);
  tipTimer = 0;
}

function revealGame() {
  loading.hidden = true;
  document.body.classList.add('in-game');
  stopTips();
  if (watchdog) {
    clearInterval(watchdog);
    watchdog = 0;
  }
}

function watchForGame() {
  if (!watchdog) watchdog = setInterval(() => { if (engineRunning()) revealGame(); }, 500);
}

const dismissLoading = () => { if (engineRunning()) revealGame(); };
window.addEventListener('keydown', dismissLoading, true);
window.addEventListener('pointerdown', dismissLoading, true);

let panicText = '';
const consoleError = console.error.bind(console);
console.error = (...args) => {
  const text = args.map(String).join(' ');
  if (!panicText && /panicked at/.test(text)) panicText = text.split('\n\nStack:')[0].trim();
  consoleError(...args);
};

function engineFailure(event) {
  const message = (event && (event.message || (event.reason && event.reason.message))) || '';
  if (!message || loading.hidden) return;
  let cause = '';

  if (/Unable to find a GPU/i.test(panicText || message)) {
    fail('Your browser did not give the game a GPU. Turn on hardware acceleration, then fully restart the browser and reload this page.\n\n' +
      '  • Chrome / Brave / Edge: Settings > System > "Use graphics acceleration when available" (Brave: "Use hardware acceleration when available"), then Relaunch.\n' +
      '  • Firefox: Settings > General > Performance > untick "Use recommended performance settings", tick "Use hardware acceleration when available".\n' +
      '  • Opera: Settings > System > "Use hardware acceleration when available".\n\n' +
      'Still failing? Update your graphics drivers, and check chrome://gpu (or edge://gpu) shows WebGPU as hardware accelerated.\n\n' +
      (panicText || message), 'TURN ON HARDWARE ACCELERATION');
    return;
  }
  if (/CreateSurfaceError|FailedToCreateSurface|requestAdapter|No suitable (GPU )?adapter/i.test(panicText)) {
    cause = `\n\nThe browser would not give the engine a WebGPU canvas. ${webgpuProblem() || 'Check that hardware acceleration is on and the browser supports WebGPU.'}`;
  } else if (!panicText && /unreachable|out of memory/i.test(message)) {

    cause = '\n\nThis is usually the engine running out of WebAssembly memory (4 GB at most) while building a large map.';
  }
  fail(`The engine stopped while loading. Reload and try again.${cause}\n\n${panicText || message}`);
}

function webgpuProblem() {
  if (!window.isSecureContext) {
    return `WebGPU only works over https or on localhost, and this page was opened as ${location.origin}. ` +
      `On this machine, open Chrome/Edge/Brave at chrome://flags/#unsafely-treat-insecure-origin-as-secure, ` +
      `add ${location.origin}, enable it, relaunch the browser and reload this page.`;
  }
  if (!navigator.gpu) {
    return 'WebGPU is not available in this browser. Use a current Chrome, Edge or Brave, and check that hardware acceleration is on.';
  }
  return '';
}
window.addEventListener('error', engineFailure);
window.addEventListener('unhandledrejection', engineFailure);

const KEY_BUTTONS = {
  Space: 0x1000, KeyE: 0x2000, KeyQ: 0x4000, KeyR: 0x8000, KeyZ: 0x0100, KeyX: 0x0200,
  Escape: 0x0010, Tab: 0x0020, KeyV: 0x0040, KeyB: 0x0080,
  KeyI: 0x0001, KeyK: 0x0002, KeyJ: 0x0004, KeyL: 0x0008,
};
const MAPPED_KEYS = new Set([
  ...Object.keys(KEY_BUTTONS), 'ShiftLeft', 'ShiftRight', 'KeyC', 'KeyW', 'KeyA', 'KeyS', 'KeyD',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
]);
const held = new Set();
window.addEventListener('keydown', (event) => {
  if (!MAPPED_KEYS.has(event.code) || !$('panel').classList.contains('hidden')) return;
  held.add(event.code);
  event.preventDefault();
});
window.addEventListener('keyup', (event) => held.delete(event.code));
window.addEventListener('blur', () => held.clear());

const TRACKPAD_GAIN = [0, 1 / 90, 1 / 55, 1 / 32];
const TRACKPAD_RETURN_MS = 75;
const trackpad = { level: 0, playing: false, x: 0, y: 0, at: performance.now() };
function setTrackpad(level, playing) {
  trackpad.level = Math.max(0, Math.min(3, level | 0));
  trackpad.playing = Boolean(playing);

  document.body.classList.toggle('paused', !trackpad.playing);
  trackpad.x = trackpad.y = 0;

  if ((!trackpad.level || !trackpad.playing) && document.pointerLockElement) document.exitPointerLock();
}
window.addEventListener('pointermove', (event) => {
  if (!trackpad.level || !trackpad.playing || !$('panel').classList.contains('hidden')) return;
  const gain = TRACKPAD_GAIN[trackpad.level];
  trackpad.x += event.movementX * gain;
  trackpad.y -= event.movementY * gain;
  const length = Math.hypot(trackpad.x, trackpad.y);
  if (length > 1) { trackpad.x /= length; trackpad.y /= length; }
});

$('skate-canvas').addEventListener('click', () => {
  if (trackpad.level && trackpad.playing && !document.pointerLockElement) {
    try { $('skate-canvas').requestPointerLock(); } catch {}
  }
});
function trackpadStick() {
  const now = performance.now();
  const keep = Math.exp(-(now - trackpad.at) / TRACKPAD_RETURN_MS);
  trackpad.at = now;
  trackpad.x *= keep;
  trackpad.y *= keep;
  if (Math.abs(trackpad.x) < 0.01) trackpad.x = 0;
  if (Math.abs(trackpad.y) < 0.01) trackpad.y = 0;
  return [Math.round(trackpad.x * 32767), Math.round(trackpad.y * 32767)];
}

function keyboardPad() {
  let buttons = 0;
  for (const [code, bit] of Object.entries(KEY_BUTTONS)) if (held.has(code)) buttons |= bit;
  const axis = (negative, positive) => (held.has(positive) ? 32767 : 0) - (held.has(negative) ? 32767 : 0);
  const lt = held.has('ShiftLeft') || held.has('ShiftRight') ? 255 : 0;
  const rt = held.has('KeyC') ? 255 : 0;

  let rx = axis('ArrowLeft', 'ArrowRight');
  let ry = axis('ArrowDown', 'ArrowUp');
  const [tx, ty] = trackpadStick();
  if (!rx && !ry) { rx = tx; ry = ty; }

  const touch = touchPad();
  let lx = axis('KeyA', 'KeyD');
  let ly = axis('KeyS', 'KeyW');
  if (!lx && !ly) [lx, ly] = touch.left;
  if (!rx && !ry) [rx, ry] = touch.right;
  return new Int32Array([
    buttons | touch.buttons, Math.max(lt, touch.lt), Math.max(rt, touch.rt),
    lx, ly,
    rx, ry,
  ]);
}

function openUrl(url) {
  if (!/^https:\/\//.test(url)) return;

  if (/discord\.gg|buymeacoffee|pump\.fun|ko-fi|patreon/i.test(url)) return;
  const opened = window.open(url, '_blank');
  if (opened) opened.opener = null;
  else document.body.classList.add('paused');
}

let picked = null;
function pickFile(accept) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (file) picked = new Uint8Array(await file.arrayBuffer());
  });
  input.click();
}
window.addEventListener('dragover', (event) => {
  if (event.dataTransfer && [...event.dataTransfer.types].includes('Files')) event.preventDefault();
});
window.addEventListener('drop', async (event) => {
  const file = event.dataTransfer && event.dataTransfer.files[0];
  if (!file || !/\.cfss$/i.test(file.name)) return;
  event.preventDefault();
  picked = new Uint8Array(await file.arrayBuffer());
});

const SMALL_SCREEN = /iPhone|iPad|iPod|Android|Mobile/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

window.skateHost = {
  keyboardPad,
  setTrackpad,
  openUrl,
  pickFile,
  takePicked: () => { const file = picked; picked = null; return file; },
  getBootConfig: async () => window.__skateBoot,
  readFile: (path) => store.readFile(path),

  prefetch: (path, background) => { if (!(background && SMALL_SCREEN)) store.prefetch(path, background); },
  writeFile: (path, data) => { store.writeFile(path, data).catch((e) => console.warn('persist failed', path, e)); },
  progress: (done, total, label) => showProgress(total ? done / total : 0, `${label} (${done}/${total})`),
  stage: showStage,

  ready: () => { store.releaseBootPackage(); revealGame(); installTouchControls(store.readFile); $('skate-canvas').focus(); },
  releaseBoot: () => store.releaseBootPackage(),
  fatal: (message) => fail(message),
  netOpen: net.open,
  netClose: net.close,
  netSend: net.send,
  netText: net.text,
  netPoll: net.poll,
  netBacklog: net.backlog,
};

$('load-back').addEventListener('click', () => location.reload());

async function enterFullscreen() {
  if (!frontend.fullscreen || document.fullscreenElement || !document.documentElement.requestFullscreen) return;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    if (navigator.keyboard && navigator.keyboard.lock) await navigator.keyboard.lock(['Escape']);
  } catch (error) {
    console.warn('fullscreen unavailable:', error && error.message ? error.message : error);
  }
}

let started = false;

async function startGame(map, name, frontEnd = false) {
  if (started) return;
  started = true;
  enterFullscreen();
  document.querySelector('.load-card h1').replaceChildren(frontend.heading(name));
  startTips();
  $('panel').classList.add('hidden');
  showStage('Checking the server for game data…');
  watchForGame();
  try {

    const module = import(`./pkg/skate3rust.js${BUILD}`);
    const gameData = store.startBootPackage((done, total, label) =>
      showProgress(total ? done / total : 0, `${label} — ${(done / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`))

      .then(() => undefined);

    window.__skateBoot = await store.bootConfig(map, params.get('difficulty'), params.has('capture'), params.get('teleport'), frontEnd);
    await gameData;
    showStage('Loading the engine…');
    await (await module).default({ module_or_path: new URL(`./pkg/skate3rust_bg.wasm${BUILD}`, import.meta.url) });
  } catch (error) {

    if (error && /Using exceptions for control flow/.test(String(error.message || error))) return;
    started = false;
    fail(error && error.stack ? error.stack : error);
  }
}

frontend = createFrontend({ store, start: startGame, gpuProblem: webgpuProblem() });

store.discardLegacyCache().catch(() => {});
