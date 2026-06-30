#!/usr/bin/env bash
# One-shot deploy of itm-live-show on a fresh Hetzner Cloud VPS (Ubuntu 22.04/24.04).
# Gives you a REAL, browser-trusted HTTPS URL — no domain to buy, no cert warning
# on phones — using Caddy + Let's Encrypt + a free <your-ip>.sslip.io hostname.
#
# Usage (as root, from the repo root):
#     bash deploy/setup.sh
#
# Optional overrides:
#     PUBLIC_IP=1.2.3.4 bash deploy/setup.sh        # if auto-detect fails
#     SITE_ADDRESS=show.example.com bash deploy/setup.sh   # use your own domain
#     HOST_KEY=mysecret bash deploy/setup.sh         # fix the director key
set -euo pipefail

cd "$(dirname "$0")/.."   # repo root, wherever this was cloned/copied

# --- public IP (Hetzner metadata, then a public echo service) ----------------
IP="${PUBLIC_IP:-}"
[ -z "$IP" ] && IP="$(curl -fsS --max-time 8 http://169.254.169.254/hetzner/v1/metadata/public-ipv4 2>/dev/null || true)"
[ -z "$IP" ] && IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || true)"
if [ -z "$IP" ]; then
  echo "!! Could not detect the public IP. Re-run as:  PUBLIC_IP=1.2.3.4 bash deploy/setup.sh" >&2
  exit 1
fi
SITE_ADDRESS="${SITE_ADDRESS:-${IP}.sslip.io}"

# --- Docker (install if missing) ---------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  echo ">> Installing Docker…"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || { echo "!! 'docker compose' plugin missing — update Docker."; exit 1; }

# --- env (keep an existing HOST_KEY so the link stays stable across re-runs) --
ENV_FILE="deploy/.env"
if [ -z "${HOST_KEY:-}" ] && [ -f "$ENV_FILE" ] && grep -q '^HOST_KEY=' "$ENV_FILE"; then
  HOST_KEY="$(grep '^HOST_KEY=' "$ENV_FILE" | cut -d= -f2)"
fi
HOST_KEY="${HOST_KEY:-$(head -c 5 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
printf 'SITE_ADDRESS=%s\nHOST_KEY=%s\n' "$SITE_ADDRESS" "$HOST_KEY" > "$ENV_FILE"

# --- build & launch ----------------------------------------------------------
echo ">> Building & starting (first build takes a minute)…"
docker compose -f deploy/docker-compose.yml --env-file "$ENV_FILE" up -d --build

cat <<EOF

──────────────────────────────────────────────────────────────────────────
  ✅ itm-live-show is live   (the first HTTPS certificate can take ~30-60s —
     if the link looks insecure for a moment, wait and refresh once)

  SEND YOUR FRIEND THIS ONE LINK  (it is the show + the on-screen QR):
      https://${SITE_ADDRESS}/preview?key=${HOST_KEY}

  Phones in the crowd just scan that QR, or open:
      https://${SITE_ADDRESS}/

  Optional consoles:
      Director/host panel:  https://${SITE_ADDRESS}/host?key=${HOST_KEY}
      Health check:         https://${SITE_ADDRESS}/healthz

  Manage later (from the repo dir on this server):
      docker compose -f deploy/docker-compose.yml logs -f     # watch logs
      docker compose -f deploy/docker-compose.yml restart     # restart
      git pull && bash deploy/setup.sh                        # update to latest
──────────────────────────────────────────────────────────────────────────
EOF
