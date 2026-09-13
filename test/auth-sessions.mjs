import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = 3561;
const base = `http://127.0.0.1:${port}`;
const server = spawn(process.execPath, ['server.js'], {
  env: {
    ...process.env,
    PORT: String(port), NODE_ENV: 'test', DATABASE_URL: '', PGLITE_DIR: '',
    OWNER_EMAIL: 'session-owner@example.org', APP_BASE_URL: base,
    SMTP_HOST: '', SMTP_USER: '', SMTP_PASS: '', LODGE_ACCESS_CODE: '',
    TRACKER_SSO_SHARED_SECRET: 'synthetic-report-assertion-secret-for-tests',
  },
  stdio: 'ignore',
});

const request = async (path, { method = 'GET', token, cookie, origin, body, webHeader = false } = {}) => {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(origin ? { Origin: origin } : {}),
      ...(webHeader ? { 'X-Stone-Square-Client': 'web' } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return {
    status: response.status,
    data: response.headers.get('content-type')?.includes('json') ? await response.json() : await response.text(),
    cookie: response.headers.get('set-cookie') || '',
    cache: response.headers.get('cache-control') || '',
  };
};

try {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const password = 'Synthetic session password';
  const registration = await request('/api/auth/register', {
    method: 'POST', webHeader: true,
    body: { email: 'session-owner@example.org', name: 'WM Session Owner', password, client: 'web' },
  });
  assert.equal(registration.status, 201);
  assert.equal(registration.data.token, undefined);
  assert.match(registration.cookie, /^ss22_session=/);
  assert.match(registration.cookie, /HttpOnly/);
  assert.match(registration.cookie, /SameSite=Strict/);
  assert.match(registration.cookie, /Path=\//);
  assert.match(registration.cookie, /Max-Age=7776000/);
  const browserCookie = registration.cookie.split(';', 1)[0];

  assert.equal((await request('/api/auth/me', { cookie: browserCookie, webHeader: true })).status, 200);
  assert.equal((await request('/api/auth/sessions/revoke-others', {
    method: 'POST', cookie: browserCookie, webHeader: true,
  })).status, 403);
  assert.equal((await request('/api/auth/sessions/revoke-others', {
    method: 'POST', cookie: browserCookie, webHeader: true, origin: 'https://untrusted.example',
  })).status, 403);

  const mac = await request('/api/auth/login', {
    method: 'POST', body: { email: 'session-owner@example.org', password },
  });
  assert.equal(mac.status, 200);
  assert.ok(mac.data.token);
  let sessions = await request('/api/auth/sessions', { cookie: browserCookie, webHeader: true });
  assert.equal(sessions.status, 200);
  assert.equal(sessions.data.sessions.length, 2);
  assert.ok(sessions.data.sessions.every((session) => !Object.hasOwn(session, 'token')));
  const other = sessions.data.sessions.find((session) => !session.current);
  assert.equal((await request(`/api/auth/sessions/${other.id}`, {
    method: 'DELETE', cookie: browserCookie, webHeader: true, origin: base,
  })).status, 200);
  assert.equal((await request('/api/auth/me', { token: mac.data.token })).status, 401);
  assert.equal((await request('/api/auth/me', { cookie: browserCookie, webHeader: true })).status, 200);

  const handoff = await request('/api/reports/handoff', {
    method: 'POST', cookie: browserCookie, webHeader: true, origin: base,
  });
  assert.equal(handoff.status, 200);
  assert.match(handoff.cache, /no-store/);
  assert.equal(new URL(handoff.data.url).origin, 'https://request.stonesquare22pha.org');
  assert.equal(new URL(handoff.data.url).search, '');
  const [payload, signature] = handoff.data.assertion.split('.');
  assert.ok(payload && signature);
  const claims = JSON.parse(Buffer.from(payload, 'base64url'));
  assert.equal(claims.aud, 'stone-square-report-generator');
  assert.equal(claims.email, 'session-owner@example.org');
  assert.ok(claims.permissions.includes('reports.create'));
  assert.ok(claims.expiresAt - claims.issuedAt <= 300);

  const legacy = await request('/api/auth/login', {
    method: 'POST', body: { email: 'session-owner@example.org', password },
  });
  const exchanged = await request('/api/auth/me', { token: legacy.data.token, webHeader: true });
  assert.match(exchanged.cookie, /^ss22_session=/);

  const logout = await request('/api/auth/logout', {
    method: 'POST', cookie: browserCookie, webHeader: true, origin: base,
  });
  assert.equal(logout.status, 200);
  assert.match(logout.cookie, /Max-Age=0/);
  assert.equal((await request('/api/auth/me', { cookie: browserCookie, webHeader: true })).status, 401);
  console.log('PASS: HttpOnly 90-day browser sessions, origin checks, per-device revocation, legacy exchange, and report handoff.');
} finally {
  server.kill();
}
