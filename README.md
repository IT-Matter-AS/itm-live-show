# itm-live-show

Turn a crowd's phones into one coordinated, music-reactive light show — **no app
download**. Scan a QR (or open a link) and your phone joins a synchronized light
display alongside everyone else's. Lightweight by design: a tiny Node server,
vanilla-JS front end, no build step, runs at any venue from a living room to a
stadium.

## How it works

We never integrate with the music source. Phones just **listen** through the mic
to whatever the speakers play — Spotify at a party, a live band at a concert.

- **Sync (the core).** Each phone detects the beat/energy of the music it hears
  and pulses its light to it. Because the whole crowd hears the same song, the
  show is coordinated with zero source control and zero integration. A shared
  tempo (crowd-median) keeps every phone drift-free.
- **Positioning (optional layer).** To tint the crowd *by location* (waves,
  ripples, text/logos across the crowd), the organizer places a few **inaudible
  ultrasonic beacons** (spare phones/speakers). Phones hear the beacons and
  trilaterate by time-difference-of-arrival. This is *our* sound alongside the
  music — we still touch nothing else. Without beacons it falls back gracefully.

The server never streams pixels. Each phone renders locally from
`color = f(position, music, time)`; the server only syncs the clock and relays
tiny directives. Per-phone server cost is ~nothing.

## Quick start

```sh
npm install
npm start
npm test      # headless DSP/sync test suite
```

- **Host console** — <http://localhost:3000/host> — QR + live head count, demo
  beat, and links to the visualizer, beacon, and venue setup.
- **Phones** (same Wi-Fi) — scan the QR → opens the self-signed **https** LAN URL
  → accept the one-time warning → **Join** → allow the mic. Tap the status line
  for a live diagnostics overlay.
- **Visualizer / director** — <http://localhost:3000/preview> — a grid of virtual
  phones running the real scene code; its controls (scene, palette, custom colors,
  reactivity, text/shape crowd-images) drive every connected phone live.
- **Venue setup** — <http://localhost:3000/setup> — set the venue size and place
  PA speakers on a map; beacons appear live.
- **Beacon** — <http://localhost:3000/anchor> — run on a spare device at a known
  spot to emit a positioning chirp.

## Deploy (no cert warning, works on cellular)

The mic and Wake Lock need a secure context. For real use, host at a domain with
managed TLS — no warning, and phones don't need the venue Wi-Fi. The server adapts:

| Env | Effect |
| --- | --- |
| `PUBLIC_URL=https://your.domain` | QR points here; no warning; cellular-friendly |
| `HTTP_ONLY=1` | serve plain HTTP only (a proxy/CDN terminates TLS) |
| `TLS_CERT_FILE` + `TLS_KEY_FILE` | use a real cert (e.g. Let's Encrypt) |
| `VENUE_W` / `VENUE_H` | default venue size in metres |
| *(none)* | self-signed cert — **LAN dev only**, one-time warning |

### Real HTTPS for a live test (cellular, no cert warning)

Phones need a *trusted* https origin (the self-signed LAN cert blocks the mic on
some browsers). Easiest first:

- **Hetzner / any VPS (recommended for a real test).** A real HTTPS URL with **no
  domain to buy** and **no cert warning** — give your non-technical friend a link
  and they just open it. See **[deploy/DEPLOY.md](deploy/DEPLOY.md)**: create a
  small Ubuntu server, then `git clone … && bash deploy/setup.sh`. Caddy fetches a
  Let's Encrypt cert for a free `<ip>.sslip.io` name and proxies to the app.
- **No install — VS Code port forwarding.** Run `npm start`, open the **Ports**
  panel → **Forward Port** `3000` → set **Visibility: Public** → open the
  `https://…devtunnels.ms` URL. Real cert, works on cellular, one action.
- **Fly.io (one command).** `fly launch` then `fly deploy` (uses `fly.toml` +
  `Dockerfile`), then `fly secrets set PUBLIC_URL=https://<app>.fly.dev`.
- **Render.** New → Blueprint → pick this repo (`render.yaml`), then set
  `PUBLIC_URL` to the assigned `https://…onrender.com` and redeploy.

In deploy modes the app serves plain HTTP behind the platform's TLS edge
(`HTTP_ONLY=1`). Access control, in order of strength:

- **Login (`AUTH_USERS="email:pw,email:pw"`).** Locks the whole deployment to
  named accounts — the QR/share URL only works for people who can sign in. A
  signed-in user is a director automatically (no key needed). Set `OPEN_CROWD=1`
  to let spectators join without a login while control still requires one. The
  Hetzner deploy turns this on and seeds the accounts for you.
- **Director key (`HOST_KEY`).** Without login, control messages require this key
  (`?key=…` in the URL); spectators get the keyless QR.
- On your own laptop, `localhost` is auto-trusted as director (no key needed).

## Synchronization & accuracy

- **Clock:** skew-corrected regression over low-jitter samples (~sub-ms), not a
  raw min-RTT offset — no drift between syncs.
- **Rhythm:** one shared crowd tempo + per-phone phase lock to the music heard.
- **Movement:** an adaptive (1€) position filter — low jitter at rest, low lag
  when walking, with outlier rejection.
- **Calibration:** per-beacon emit-latency calibration (open a phone at a known
  spot with `?cal=x,y`) removes the biggest real-world positioning bias.
- **Multi-speaker:** with speaker locations + position, phones compensate sound
  travel time so the whole crowd locks to the *source* beat.
- **Stadium scale:** TDMA beacon slots are **reused** across far-apart zones
  (cellular-style); a phone hears its nearest cluster and disambiguates by fit.

The DSP/sync core is covered by a headless test suite (`npm test`): matched-filter
ranging, TDOA positioning, slot-reuse, beat detection, clock filter, phase lock,
motion filter, and beacon calibration.

## Layout

- [public/dsp.js](public/dsp.js) — signal + sync core (pure, tested headless).
- [public/show.js](public/show.js) — scene engine: palettes, scenes, director.
- [public/app.js](public/app.js) — spectator: mic, rhythm, positioning, render.
- [public/preview.js](public/preview.js) — crowd visualizer / live director.
- [public/setup.js](public/setup.js) — venue + speaker setup map.
- [public/anchor.js](public/anchor.js) — ultrasonic beacon emitter.
- [server/server.js](server/server.js) — static serving, clock sync, relays, deploy modes.

## Status

Music-reactive sync, coordinated scenes + crowd-images, reconnecting realtime,
deployment-ready TLS, and the full positioning stack (beacons, calibration,
slot-reuse) are implemented; the DSP/sync core is verified headless. The acoustic
positioning path needs real-hardware tuning (≥3 beacon devices) — until then,
positions fall back to simulated and the music-sync show works on its own.
