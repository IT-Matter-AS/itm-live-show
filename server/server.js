import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import QRCode from 'qrcode';
import selfsigned from 'selfsigned';
import { WebSocketServer } from 'ws';
import { AUDIO, TempoEstimator } from '../public/dsp.js';

// Resilience: a long-running event server must outlive any single bad request
// or dropped socket. Log and carry on instead of crashing.
process.on('uncaughtException', (e) => console.error('uncaughtException:', e?.message || e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e?.message || e));

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const HTTP_PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const BPM = 120;

// Deployment config — this is the real answer to the self-signed cert warning:
//   PUBLIC_URL    public https URL of a real deployment, e.g. https://live.show
//                 When set, the QR points here: no warning, and it works over
//                 cellular (phones no longer need to share the venue's Wi-Fi).
//   HTTP_ONLY=1   serve plain HTTP only (a managed proxy/CDN terminates TLS).
//   TLS_CERT_FILE / TLS_KEY_FILE   paths to a real certificate (e.g. Let's Encrypt).
// With none set, we fall back to a self-signed cert for LAN dev only.
const PUBLIC_URL = process.env.PUBLIC_URL;
const HTTP_ONLY = process.env.HTTP_ONLY === '1';
const TLS_CERT_FILE = process.env.TLS_CERT_FILE;
const TLS_KEY_FILE = process.env.TLS_KEY_FILE;

// Positioning venue in metres — phones normalize beacon coordinates by this.
// Mutable: a setup console can reshape the venue and place PA speakers live.
let VENUE = { width: Number(process.env.VENUE_W) || 10, height: Number(process.env.VENUE_H) || 7 };
let speakers = [];           // PA speaker locations [{x,y}] — used for propagation compensation
let beaconOffsets = {};      // calibrated per-beacon emit latencies (slot -> seconds)
const MAX_ANCHORS = Math.floor(AUDIO.frameMs / AUDIO.slotMs); // TDMA slots per cycle
const tempo = new TempoEstimator();

// Persist the venue config so a "save" survives a server restart.
const CONFIG_FILE = join(ROOT, '.venue.json');
function loadVenueConfig() {
  try {
    if (!existsSync(CONFIG_FILE)) return;
    const c = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    if (c.venue?.width && c.venue?.height) VENUE = c.venue;
    if (Array.isArray(c.speakers)) speakers = c.speakers;
    if (c.beaconOffsets) beaconOffsets = c.beaconOffsets;
  } catch {}
}
function saveVenueConfig() {
  try { writeFileSync(CONFIG_FILE, JSON.stringify({ venue: VENUE, speakers, beaconOffsets })); } catch {}
}
loadVenueConfig();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function lanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return 'localhost';
}
const LAN_IP = lanIP();

// The URL phones should open. A secure context (https) is mandatory — the mic
// and Wake Lock both require it. In production this is your real PUBLIC_URL
// (no warning, works on cellular); in dev it's the self-signed https LAN URL.
function joinURL() {
  if (PUBLIC_URL) return PUBLIC_URL.endsWith('/') ? PUBLIC_URL : PUBLIC_URL + '/';
  if (HTTP_ONLY) return `http://${LAN_IP}:${HTTP_PORT}/`;
  return `https://${LAN_IP}:${HTTPS_PORT}/`;
}

// Map a URL path to a file on disk, guarding against path traversal.
function resolveFile(urlPath) {
  let rel;
  if (urlPath === '/' || urlPath === '') rel = 'public/index.html';
  else if (urlPath === '/host' || urlPath === '/host/') rel = 'host/host.html';
  else if (urlPath.startsWith('/host/')) rel = 'host/' + urlPath.slice('/host/'.length);
  else if (urlPath === '/preview') rel = 'public/preview.html';
  else if (urlPath === '/anchor') rel = 'public/anchor.html';
  else if (urlPath === '/setup') rel = 'public/setup.html';
  else rel = 'public/' + urlPath.replace(/^\/+/, '');
  const full = resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return null;
  return full;
}

async function handler(req, res) {
  // Parse defensively: a malformed path (e.g. "//") must never crash the server.
  let u, urlPath;
  try {
    u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    urlPath = decodeURIComponent(u.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    return;
  }

  try {
    // Tell the host console which URL to advertise to phones.
    if (urlPath === '/info') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ joinUrl: joinURL() }));
      return;
    }
    // On-the-fly QR (SVG) encoding whatever URL the host console asks for.
    if (urlPath === '/qr.svg') {
      const data = u.searchParams.get('data') || joinURL();
      const svg = await QRCode.toString(data, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(svg);
      return;
    }

    const file = resolveFile(urlPath);
    if (!file) { res.writeHead(403).end('Forbidden'); return; }
    const data = await readFile(file);
    // no-cache during active iteration so phones never run a stale page version.
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    if (!res.headersSent) res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    else try { res.end(); } catch {}
  }
}

// Self-signed TLS cert, cached on disk so phones only see the warning once and
// the cert stays stable across restarts.
async function tlsOptions() {
  const dir = join(ROOT, '.cert');
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  }
  // selfsigned v5's generate() is async and builds the SAN (where the LAN IP
  // must live) from node-forge-style extensions.
  const pems = await selfsigned.generate([{ name: 'commonName', value: LAN_IP }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + 825 * 864e5),
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: LAN_IP },
      ] },
    ],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyPath, pems.private);
  writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

// Build the listener set for the active deployment mode.
const httpServer = http.createServer(handler);
const listeners = [{ server: httpServer, port: HTTP_PORT }];

let httpsServer = null;
if (!HTTP_ONLY) {
  const tls = (TLS_CERT_FILE && TLS_KEY_FILE)
    ? { key: readFileSync(TLS_KEY_FILE), cert: readFileSync(TLS_CERT_FILE) }
    : await tlsOptions();
  httpsServer = https.createServer(tls, handler);
  listeners.push({ server: httpsServer, port: HTTPS_PORT });
}

// --- Realtime layer ---------------------------------------------------------
// The server does almost nothing per-phone: it answers clock-sync pings and
// relays small coordination messages. No light frames are ever streamed.
const wss = new WebSocketServer({ noServer: true });
for (const { server } of listeners) {
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}

const spectators = new Set();   // phones that have joined (for the live head count)
let currentShow = null;         // { type:'show', name, startAt, bpm } in server-clock ms
let currentScene = { type: 'scene', scene: 'auto', palette: 'auto', epoch: Date.now() };
const anchors = new Map(); // ws -> { slot, x, y } (a slot may be reused far apart)

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(data);
}
const broadcastCount = () => broadcast({ type: 'count', n: spectators.size });
const anchorList = () => [...anchors.values()].map((a) => ({ slot: a.slot, x: a.x, y: a.y }));
const anchorsMsg = () => ({ type: 'anchors', venue: VENUE, list: anchorList(), speakers, offsets: beaconOffsets });
const broadcastAnchors = () => broadcast(anchorsMsg());

wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    switch (msg.type) {
      case 'ping': // NTP-style clock sync: echo client stamp, add server time.
        ws.send(JSON.stringify({ type: 'pong', t0: msg.t0, ts: Date.now() }));
        break;
      case 'hello': // A spectator (re)joined — count it, send show/look/beacons.
        spectators.add(ws);
        if (currentShow) ws.send(JSON.stringify(currentShow));
        ws.send(JSON.stringify(currentScene));
        ws.send(JSON.stringify(anchorsMsg()));
        broadcastCount();
        break;
      case 'host': // The console / visualizer / setup — head count, look, venue.
        ws.send(JSON.stringify({ type: 'count', n: spectators.size }));
        ws.send(JSON.stringify(currentScene));
        ws.send(JSON.stringify(anchorsMsg())); // so /setup shows the saved venue + speakers
        break;
      case 'anchor': { // A positioning beacon registering its known position.
        const x = Number(msg.x) || 0, y = Number(msg.y) || 0;
        let slot;
        const existing = anchors.get(ws);
        if (existing) { slot = existing.slot; }
        else {
          // Assign the slot whose nearest same-slot beacon is FARTHEST away (empty
          // slots first) so reused slots stay far apart — a phone hears only one.
          const groups = {};
          for (const a of anchors.values()) (groups[a.slot] = groups[a.slot] || []).push(a);
          let bestSlot = 0, bestScore = -1;
          for (let s = 0; s < MAX_ANCHORS; s++) {
            const g = groups[s] || [];
            const score = g.length === 0 ? Infinity : Math.min(...g.map((a) => Math.hypot(a.x - x, a.y - y)));
            if (score > bestScore) { bestScore = score; bestSlot = s; }
          }
          slot = bestSlot;
        }
        anchors.set(ws, { slot, x, y });
        ws.send(JSON.stringify({ type: 'anchor-ok', slot }));
        broadcastAnchors();
        break;
      }
      case 'scene': // Director (visualizer/host) changed the look — relay to all.
        currentScene = {
          type: 'scene',
          scene: msg.scene ?? currentScene.scene,
          palette: msg.palette ?? currentScene.palette,    // name | 'auto' | {stops}
          react: msg.react ?? currentScene.react,          // { brightness, beat, speed }
          image: 'image' in msg ? msg.image : currentScene.image, // crowd-as-screen grid
          epoch: msg.epoch || Date.now(),
        };
        broadcast(currentScene);
        break;
      case 'start': // Trigger a show a few seconds out so everyone can align.
        currentShow = { type: 'show', name: msg.name || 'wave', startAt: Date.now() + 3000, bpm: BPM };
        broadcast(currentShow);
        break;
      case 'stop':
        currentShow = null;
        broadcast({ type: 'stop' });
        break;
      case 'bpm': // A phone's local tempo estimate -> feeds the crowd-median tempo.
        tempo.add(msg.bpm, Date.now());
        break;
      case 'calib': // Beacon emit-latency calibration from a known-position phone.
        beaconOffsets = { ...beaconOffsets, ...(msg.offsets || {}) };
        saveVenueConfig();
        broadcastAnchors();
        break;
      case 'config': // Setup console: reshape venue / place PA speakers.
        if (msg.venue && msg.venue.width && msg.venue.height) VENUE = { width: Number(msg.venue.width), height: Number(msg.venue.height) };
        if (Array.isArray(msg.speakers)) speakers = msg.speakers.map((s) => ({ x: Number(s.x) || 0, y: Number(s.y) || 0 }));
        saveVenueConfig();
        broadcastAnchors();
        break;
    }
  });
  ws.on('close', () => {
    if (spectators.delete(ws)) broadcastCount();
    if (anchors.delete(ws)) broadcastAnchors();
  });
});

// Broadcast the crowd-median tempo so every phone shares one drift-free BPM.
setInterval(() => { const b = tempo.bpm(Date.now()); if (b) broadcast({ type: 'tempo', bpm: b }); }, 1000);

httpServer.listen(HTTP_PORT, () => {
  console.log('itm-live-show running:');
  console.log(`  Host console (this machine): http://localhost:${HTTP_PORT}/host`);
  console.log(`  Phones should open:          ${joinURL()}`);
  if (HTTP_ONLY) console.log('  Mode: HTTP_ONLY (a managed proxy/CDN terminates TLS).');
});
if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, () => {
    if (PUBLIC_URL || TLS_CERT_FILE) {
      console.log('  TLS: using the provided certificate / public URL — no warning.');
    } else {
      console.log('  TLS: self-signed (DEV ONLY) — phones show a one-time "Not private" warning.');
      console.log('       Remove it for real use: deploy behind managed TLS and set PUBLIC_URL,');
      console.log('       or pass TLS_CERT_FILE / TLS_KEY_FILE (e.g. Let\'s Encrypt).');
    }
  });
}
