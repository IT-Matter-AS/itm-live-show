// Tiny, dependency-free login for locking a deployment to a known set of people.
// Credentials come from the AUTH_USERS env var ("email:password,email:password");
// passwords are kept only as scrypt hashes. Sessions are random opaque tokens in
// an in-memory store, handed out via an HttpOnly cookie. This is deliberately
// small — enough to gate a private test, not a full identity system.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// "a@b.com:secret,c@d.com:hunter2" -> Map(email -> { salt, hash }).
// Passwords may contain any character except a comma (the pair separator).
export function parseUsers(spec) {
  const users = new Map();
  for (const pair of String(spec || '').split(',')) {
    const i = pair.indexOf(':');
    if (i < 1) continue;
    const email = pair.slice(0, i).trim().toLowerCase();
    const pw = pair.slice(i + 1);
    if (!email || !pw) continue;
    const salt = randomBytes(16);
    users.set(email, { salt, hash: scryptSync(pw, salt, 32) });
  }
  return users;
}

// Constant-time password check. Returns the canonical email on success, else null.
export function verifyUser(users, email, pw) {
  const key = String(email || '').trim().toLowerCase();
  const u = users.get(key);
  if (!u) return null;
  let h;
  try { h = scryptSync(String(pw ?? ''), u.salt, 32); } catch { return null; }
  return h.length === u.hash.length && timingSafeEqual(h, u.hash) ? key : null;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// Server-side session store. Tokens are unguessable; nothing sensitive lives in
// the cookie itself.
export class Sessions {
  constructor(ttlMs = SESSION_TTL_MS) { this.ttlMs = ttlMs; this.map = new Map(); }
  create(email) {
    this._prune();
    const token = randomBytes(24).toString('hex');
    this.map.set(token, { email, exp: nowMsSafe() + this.ttlMs });
    return token;
  }
  emailFor(token) {
    const s = token && this.map.get(token);
    if (!s) return null;
    if (s.exp < nowMsSafe()) { this.map.delete(token); return null; }
    return s.email;
  }
  destroy(token) { if (token) this.map.delete(token); }
  _prune() { const t = nowMsSafe(); for (const [k, v] of this.map) if (v.exp < t) this.map.delete(k); }
}

// Date.now via Function to stay out of the way of any test-time clock stubs.
function nowMsSafe() { return Date.now(); }

// Restrict redirects to same-site relative paths (no "//evil.com" open redirect).
export function safeNext(raw) {
  const s = String(raw || '');
  return s.startsWith('/') && !s.startsWith('//') ? s : '/';
}

export function cookieHeader(token, { secure }) {
  const base = `sid=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  return secure ? base + '; Secure' : base;
}
export function clearCookieHeader({ secure }) {
  const base = 'sid=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0';
  return secure ? base + '; Secure' : base;
}

export function loginPage({ error = false, next = '/' } = {}) {
  const n = String(next).replace(/"/g, '&quot;');
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · itm-live-show</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a12;
    color:#e8e8f0;font:16px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .card{width:min(360px,92vw);padding:28px 26px;border:1px solid #23233a;border-radius:16px;
    background:linear-gradient(180deg,#13131f,#0e0e18);box-shadow:0 20px 60px #0008}
  h1{margin:0 0 4px;font-size:20px}
  p.sub{margin:0 0 20px;color:#8a8aa5;font-size:13px}
  label{display:block;margin:14px 0 6px;font-size:13px;color:#b8b8d0}
  input{width:100%;padding:11px 12px;border:1px solid #2c2c46;border-radius:10px;
    background:#0c0c16;color:#fff;font-size:16px}
  input:focus{outline:none;border-color:#6c6cff;box-shadow:0 0 0 3px #6c6cff33}
  button{margin-top:20px;width:100%;padding:12px;border:0;border-radius:10px;cursor:pointer;
    background:linear-gradient(90deg,#6c6cff,#a14cff);color:#fff;font-size:16px;font-weight:600}
  .err{margin-top:14px;padding:9px 12px;border-radius:9px;background:#3a1320;
    border:1px solid #5e1d33;color:#ffb3c4;font-size:13px${error ? '' : ';display:none'}}
</style></head><body>
  <form class="card" method="POST" action="/login">
    <h1>🔦 Sign in</h1>
    <p class="sub">itm-live-show is private — sign in to continue.</p>
    <input type="hidden" name="next" value="${n}">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="username" required autofocus inputmode="email">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <div class="err">Wrong email or password.</div>
    <button type="submit">Sign in</button>
  </form>
</body></html>`;
}
