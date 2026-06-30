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
  curl -fsSL https://get.docker.com | sh || true   # may not support a brand-new Ubuntu yet
fi
# Make sure we actually have engine + compose + buildx. Fall back to Ubuntu's own
# packages — these work even on a just-released Ubuntu the Docker repo hasn't
# caught up with yet (e.g. 26.04 in its first weeks).
if ! docker compose version >/dev/null 2>&1 || ! docker buildx version >/dev/null 2>&1; then
  echo ">> Installing Docker from the Ubuntu repositories…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  apt-get install -y docker.io docker-compose-v2 docker-buildx \
    || apt-get install -y docker.io docker-compose-v2   # buildx is nice-to-have; legacy builder works too
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || {
  echo "!! Docker Compose still unavailable. Install it manually, then re-run:"
  echo "   https://docs.docker.com/engine/install/ubuntu/"
  exit 1
}

# --- env (keep existing secrets so links/passwords stay stable across re-runs) -
ENV_FILE="deploy/.env"
getenv() { [ -f "$ENV_FILE" ] && grep "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true; }
randpw() { head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n'; }   # 12 hex chars; no infinite pipe (SIGPIPE-safe under pipefail)

[ -z "${HOST_KEY:-}" ] && HOST_KEY="$(getenv HOST_KEY)"
HOST_KEY="${HOST_KEY:-$(head -c 5 /dev/urandom | od -An -tx1 | tr -d ' \n')}"

# Seeded accounts that may sign in. Re-runs keep existing passwords (so links you
# already shared keep working); a brand-new email gets a fresh random password.
SEED_EMAILS="monsterhagen@gmail.com botn@itmatter.no hagen@itmatter.no"
AUTH_USERS="${AUTH_USERS:-}"
if [ -z "$AUTH_USERS" ]; then
  PREV_AUTH="$(getenv AUTH_USERS)"
  PAIRS=""
  for email in $SEED_EMAILS; do
    pw=""
    # reuse this email's password from a previous run if present
    case ",$PREV_AUTH," in *",$email:"*)
      pw="$(printf '%s' "$PREV_AUTH" | tr ',' '\n' | grep "^$email:" | head -1 | cut -d: -f2-)";;
    esac
    [ -z "$pw" ] && pw="$(randpw)"
    PAIRS="${PAIRS:+$PAIRS,}$email:$pw"
  done
  AUTH_USERS="$PAIRS"
fi

{ printf 'SITE_ADDRESS=%s\n' "$SITE_ADDRESS"
  printf 'HOST_KEY=%s\n' "$HOST_KEY"
  printf 'AUTH_USERS=%s\n' "$AUTH_USERS"
  printf 'OPEN_CROWD=%s\n' "${OPEN_CROWD:-}"
} > "$ENV_FILE"
chmod 600 "$ENV_FILE" 2>/dev/null || true

# --- build & launch ----------------------------------------------------------
echo ">> Building & starting (first build takes a minute)…"
docker compose -f deploy/docker-compose.yml --env-file "$ENV_FILE" up -d --build

echo
echo "──────────────────────────────────────────────────────────────────────────"
echo "  ✅ itm-live-show is live   (the first HTTPS certificate can take ~30-60s —"
echo "     if the link looks insecure for a moment, wait and refresh once)"
echo
echo "  THE APP IS PRIVATE — these accounts can sign in (send each person theirs):"
printf '%s\n' "$AUTH_USERS" | tr ',' '\n' | while IFS=: read -r email pw; do
  printf '      %-26s  password: %s\n' "$email" "$pw"
done
echo
echo "  SEND YOUR FRIEND THIS LINK (it is the show — he signs in, then runs it):"
echo "      https://${SITE_ADDRESS}/preview"
echo
echo "  Phones in the crowd scan the on-screen QR, or open (they sign in too):"
echo "      https://${SITE_ADDRESS}/"
echo
echo "  Health check:  https://${SITE_ADDRESS}/healthz"
echo "  Sign out:      https://${SITE_ADDRESS}/logout"
echo
echo "  Manage later (from the repo dir on this server):"
echo "      docker compose -f deploy/docker-compose.yml logs -f     # watch logs"
echo "      docker compose -f deploy/docker-compose.yml restart     # restart"
echo "      git pull && bash deploy/setup.sh                        # update to latest"
echo
echo "  (Credentials are saved in deploy/.env. Re-running keeps them. To let the"
echo "   crowd join WITHOUT a login for a real show: OPEN_CROWD=1 bash deploy/setup.sh)"
echo "──────────────────────────────────────────────────────────────────────────"
