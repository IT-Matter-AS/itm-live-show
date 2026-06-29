// Venue setup console: define the venue size, place PA speakers on a top-down
// map, and see beacons as they come online. Broadcasts a {type:'config'} so every
// phone normalizes positions to this venue and can compensate speaker propagation.

const canvas = document.getElementById('map');
const g = canvas.getContext('2d');
const wIn = document.getElementById('w'), hIn = document.getElementById('h');

let venue = { width: 10, height: 7 };
let speakers = [];   // editable here
let beacons = [];    // live, from the server

// --- Realtime --------------------------------------------------------------
let ws = null;
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'host' })));
  ws.addEventListener('message', (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.type === 'anchors') {
      beacons = m.list || [];
      if (m.venue) { venue = m.venue; wIn.value = venue.width; hIn.value = venue.height; }
      if (m.speakers && m.speakers.length && !speakers.length) speakers = m.speakers.slice();
    }
  });
  ws.addEventListener('close', () => setTimeout(connect, 1500));
  ws.addEventListener('error', () => { try { ws.close(); } catch {} });
}
connect();

let savedTimer = null;
function save() {
  venue = { width: Number(wIn.value) || 10, height: Number(hIn.value) || 7 };
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'config', venue, speakers }));
    const s = document.getElementById('saved');
    if (s) { s.textContent = 'saved ✓'; clearTimeout(savedTimer); savedTimer = setTimeout(() => { s.textContent = ''; }, 1500); }
  }
}
document.getElementById('save').onclick = save;
document.getElementById('clear').onclick = () => { speakers = []; save(); };
wIn.onchange = hIn.onchange = () => { venue = { width: Number(wIn.value) || 10, height: Number(hIn.value) || 7 }; };

// --- Map: coordinate transforms --------------------------------------------
const PAD = 40;
function layout() {
  const W = canvas.width, H = canvas.height;
  const s = Math.min((W - 2 * PAD) / venue.width, (H - 2 * PAD) / venue.height);
  const ox = (W - venue.width * s) / 2, oy = (H - venue.height * s) / 2;
  return { s, ox, oy };
}
const toScreen = (p, L) => ({ X: L.ox + p.x * L.s, Y: L.oy + p.y * L.s });
const toVenue = (mx, my, L) => ({ x: (mx - L.ox) / L.s, y: (my - L.oy) / L.s });

canvas.addEventListener('click', (e) => {
  const r = canvas.getBoundingClientRect();
  const dpr = canvas.width / r.width;
  const mx = (e.clientX - r.left) * dpr, my = (e.clientY - r.top) * dpr;
  const L = layout();
  // remove if clicking an existing speaker
  for (let i = 0; i < speakers.length; i++) {
    const sp = toScreen(speakers[i], L);
    if (Math.hypot(sp.X - mx, sp.Y - my) < 16 * dpr) { speakers.splice(i, 1); save(); return; }
  }
  const v = toVenue(mx, my, L);
  if (v.x >= -0.5 && v.x <= venue.width + 0.5 && v.y >= -0.5 && v.y <= venue.height + 0.5) {
    speakers.push({ x: +Math.max(0, Math.min(venue.width, v.x)).toFixed(1), y: +Math.max(0, Math.min(venue.height, v.y)).toFixed(1) });
    save();
  }
});

function resize() {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
  canvas.height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
}
window.addEventListener('resize', resize);
setTimeout(resize, 0);

function marker(p, color, label, L) {
  const { X, Y } = toScreen(p, L);
  g.fillStyle = color; g.beginPath(); g.arc(X, Y, 9, 0, 6.2832); g.fill();
  g.fillStyle = '#fff'; g.font = '12px system-ui'; g.fillText(label, X + 12, Y + 4);
}
function draw() {
  requestAnimationFrame(draw);
  if (canvas.width < 2) resize();
  const W = canvas.width, H = canvas.height, L = layout();
  g.fillStyle = '#02040a'; g.fillRect(0, 0, W, H);
  // venue rectangle + grid
  g.strokeStyle = '#ffffff35'; g.lineWidth = 2;
  g.strokeRect(L.ox, L.oy, venue.width * L.s, venue.height * L.s);
  g.strokeStyle = '#ffffff12'; g.lineWidth = 1;
  for (let x = 1; x < venue.width; x++) { g.beginPath(); g.moveTo(L.ox + x * L.s, L.oy); g.lineTo(L.ox + x * L.s, L.oy + venue.height * L.s); g.stroke(); }
  for (let y = 1; y < venue.height; y++) { g.beginPath(); g.moveTo(L.ox, L.oy + y * L.s); g.lineTo(L.ox + venue.width * L.s, L.oy + y * L.s); g.stroke(); }
  for (const sp of speakers) marker(sp, '#3a8bff', `${sp.x},${sp.y}`, L);
  for (const b of beacons) marker(b, '#19ff7a', `#${b.slot}`, L);
}
draw();
