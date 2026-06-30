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
4. **Type:** the cheapest **CX22** (2 vCPU / 4 GB) is plenty.
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

## 3. Send your friend ONE link

The script prints it. It looks like:

```
https://91-99-12-34.sslip.io/preview?key=ab12cd34ef
```

That single link is **the show**: he opens it on his Mac, clicks **Capture
music**, plays a song, and the on-screen **QR code** is what the crowd scans.
Phones that scan it open `https://…sslip.io/` and light up — no install, no
warning. (`sslip.io` is just a free DNS trick that maps the name back to your
server's IP so Let's Encrypt can issue a real cert — nothing to set up.)

Keep the `?key=…` part private-ish — it's what authorizes *controlling* the
show. The crowd link (without the key) can only watch and join.

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

## Use your own domain instead of sslip.io (optional)

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
