// Unit tests for the login layer (server/auth.js). No network — just the pure
// credential / session / cookie logic that gates a deployment.
import { parseUsers, verifyUser, parseCookies, Sessions, safeNext, cookieHeader, clearCookieHeader, loginPage } from '../server/auth.js';

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

// --- seeding + password verification ----------------------------------------
{
  const users = parseUsers('monsterhagen@gmail.com:pw-one,botn@itmatter.no:Sea_horse9,hagen@itmatter.no:third');
  ok(users.size === 3, `seeds all three accounts (${users.size})`);
  ok(verifyUser(users, 'botn@itmatter.no', 'Sea_horse9') === 'botn@itmatter.no', 'correct password verifies');
  ok(verifyUser(users, 'BOTN@itmatter.no', 'Sea_horse9') === 'botn@itmatter.no', 'email match is case-insensitive');
  ok(verifyUser(users, 'botn@itmatter.no', 'wrong') === null, 'wrong password rejected');
  ok(verifyUser(users, 'nobody@x.com', 'pw-one') === null, 'unknown user rejected');
  ok(verifyUser(users, 'monsterhagen@gmail.com', 'pw-one') === 'monsterhagen@gmail.com', 'gmail account verifies');
  ok(verifyUser(users, 'botn@itmatter.no', '') === null, 'empty password rejected');
}

// --- malformed specs ---------------------------------------------------------
{
  ok(parseUsers('').size === 0, 'empty spec -> no users (login stays off)');
  ok(parseUsers(undefined).size === 0, 'undefined spec -> no users');
  ok(parseUsers('noseparator,also-bad').size === 0, 'pairs without ":" are skipped');
  const partial = parseUsers('good@x.com:pw,broken');
  ok(partial.size === 1, 'a broken pair does not drop the good ones');
}

// --- session store -----------------------------------------------------------
{
  const s = new Sessions();
  const tok = s.create('botn@itmatter.no');
  ok(typeof tok === 'string' && tok.length >= 32, 'session token is long & random');
  ok(s.emailFor(tok) === 'botn@itmatter.no', 'token resolves to its email');
  ok(s.emailFor('deadbeef') === null, 'unknown token -> null');
  s.destroy(tok);
  ok(s.emailFor(tok) === null, 'destroyed token -> null (logout works)');

  const expired = new Sessions(-1); // already expired on creation
  const t2 = expired.create('x@y.z');
  ok(expired.emailFor(t2) === null, 'expired session -> null');
}

// --- cookie parsing ----------------------------------------------------------
{
  const c = parseCookies('sid=abc123; theme=dark; foo=a%20b');
  ok(c.sid === 'abc123', 'parses sid from a cookie header');
  ok(c.foo === 'a b', 'url-decodes cookie values');
  ok(Object.keys(parseCookies('')).length === 0, 'empty header -> {}');
  ok(Object.keys(parseCookies(undefined)).length === 0, 'missing header -> {}');
}

// --- open-redirect defense ---------------------------------------------------
{
  ok(safeNext('/preview') === '/preview', 'relative path allowed');
  ok(safeNext('//evil.com') === '/', 'protocol-relative URL blocked');
  ok(safeNext('https://evil.com') === '/', 'absolute URL blocked');
  ok(safeNext('') === '/', 'empty -> root');
  ok(safeNext(null) === '/', 'null -> root');
}

// --- cookie header flags -----------------------------------------------------
{
  const sec = cookieHeader('tok', { secure: true });
  ok(/HttpOnly/.test(sec) && /SameSite=Lax/.test(sec) && /Secure/.test(sec), 'secure cookie has HttpOnly+SameSite+Secure');
  ok(!/Secure/.test(cookieHeader('tok', { secure: false })), 'non-secure cookie omits Secure');
  ok(/Max-Age=0/.test(clearCookieHeader({ secure: true })), 'clear cookie expires immediately');
}

// --- login page renders the error/next safely -------------------------------
{
  const errHtml = loginPage({ error: true, next: '/preview"><script>x' });
  ok(errHtml.includes('Wrong email or password'), 'login page shows the error copy');
  ok(!errHtml.includes('"><script>'), 'next value is attribute-escaped (no HTML injection)');
  ok(!/\.err\{[^}]*display:none/.test(errHtml), 'error state: message is visible');
  ok(/\.err\{[^}]*display:none/.test(loginPage({ error: false })), 'no-error state: message is hidden');
}

console.log(failures === 0 ? '\nALL AUTH TESTS PASSED' : `\n${failures} AUTH TEST(S) FAILED`);
process.exit(failures ? 1 : 0);
