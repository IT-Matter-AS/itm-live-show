# Deploy itm-live-show on Hetzner (real HTTPS, no domain needed)

This puts the app on a small Hetzner Cloud server behind **Caddy**, which fetches
a real, browser-trusted HTTPS certificate automatically. Your friend then just
**opens a link** — nothing to install, and **no "Not Private" warning** on any
phone. Total time ≈ 10 minutes; the server costs a few € / month.

> Why hosted instead of running on the Mac? Phones need a *secure* page (HTTPS)
> to use the mic / audio / screen-wake. A real cert avoids the scary warning that
> a self-signed (localhost) setup shows on every phone.

---

## 1. Create the server (once)

In the [Hetzner Cloud console](https://console.hetzner.com/projects/15174242):

1. **Add Server**.
2. **Location:** anything close to you (e.g. Nuremberg / Helsinki).
3. **Image:** Ubuntu 24.04.
4. **Type:** pick **Arm64 (Ampere)** — the **CAX11** (2 vCPU / 4 GB) is the
   cheapest and is plenty. Arm is cheaper than the Intel/AMD x86 types and the
   app's images (Node, Caddy) are multi-arch, so it just works. (An x86 **CX22**
   is fine too if you prefer — same steps.)
5. **SSH key:** add yours (recommended), or let it email a root password.
6. Create it, and copy the server's **public IPv4** (e.g. `91.99.12.34`).

> If you attach a Hetzner **Firewall**, allow inbound **TCP 22, 80, 443**.
> With no firewall attached (the default), all ports are already open.

## 2. Deploy (one paste)

From your machine, connect and run the setup. Replace `YOUR_IP`:

```bash
ssh root@YOUR_IP
# then, on the server:
apt-get update && apt-get install -y git
git clone https://github.com/IT-Matter-AS/itm-live-show.git
cd itm-live-show
bash deploy/setup.sh
```

The script installs Docker, builds the app, fetches the HTTPS cert, and prints
your links. The first certificate can take ~30–60s — if the page looks insecure
for a moment, wait and refresh once.

## 3. Sign-in is required (private app)

The app is **locked to three accounts** so only your people can open it. The
script seeds them and **prints each email with its generated password**:

```
monsterhagen@gmail.com      password: c32x3tp7ae
botn@itmatter.no            password: 6tgpmc4q79
hagen@itmatter.no           password: hydg88fnjb
```

Send each person their own email + password. (Passwords are saved in
`deploy/.env` and survive re-runs, so the credentials you hand out keep working.
To change one, edit the `AUTH_USERS=` line in `deploy/.env` and
`docker compose -f deploy/docker-compose.yml up -d`.)

## 4. Send your friend the link

```
https://91-99-12-34.nip.io/preview
```

He opens it on his Mac, **signs in**, clicks **Capture music**, plays a song,
and the on-screen **QR code** is what the crowd scans. Phones that scan it open
`https://…nip.io/`, sign in, and light up — no install, no cert warning.
(`nip.io` is just a free DNS trick that maps the name back to your server's IP
so Let's Encrypt can issue a real cert — nothing to set up.) A signed-in user
can control the show directly — no `?key=` needed.

> **Note on wildcard-DNS blocking.** Some ISP filters (e.g. Telenor "Nettvern")
> block `sslip.io`; we default to `nip.io`, which those filters generally allow.
> If a network blocks `nip.io` too, the browser shows a cert error
> (`ERR_CERT_COMMON_NAME_INVALID`) because the lookup is redirected to a block
> page. The permanent fix is a real domain (see the bottom of this file).

> **Real public show later?** Requiring every phone to sign in is great for a
> private test but not for an open crowd. Run `OPEN_CROWD=1 bash deploy/setup.sh`
> to let spectators join with **no login**, while running the show still
> requires one. To drop logins entirely, blank the `AUTH_USERS=` line.

---

## Everyday commands (on the server, in the `itm-live-show` folder)

```bash
docker compose -f deploy/docker-compose.yml logs -f      # watch live logs
docker compose -f deploy/docker-compose.yml restart      # restart it
docker compose -f deploy/docker-compose.yml down         # stop everything
git pull && bash deploy/setup.sh                         # update to the latest
```

The director key is saved in `deploy/.env`, so re-running `setup.sh` keeps the
**same link**. To rotate it, delete that line (or set `HOST_KEY=…`) and re-run.

## Use your own domain instead of nip.io (optional)

Point an `A` record at the server's IP, then:

```bash
SITE_ADDRESS=show.yourdomain.com bash deploy/setup.sh
```

Caddy will get a cert for that name automatically.

## Troubleshooting

- **Cert won't issue / still insecure after a minute:** ports 80 and 443 must be
  reachable. Check any Hetzner Firewall, then
  `docker compose -f deploy/docker-compose.yml logs caddy`.
- **Couldn't detect the IP:** `PUBLIC_IP=YOUR_IP bash deploy/setup.sh`.
- **Friend's phone shows nothing:** confirm the QR points to the `https://…` URL
  (it does automatically via `PUBLIC_URL`), and that he clicked **Capture music**
  and allowed the audio prompt on his Mac.
