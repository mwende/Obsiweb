import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTestEnv, PASSWORD, type TestEnv } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

let env: TestEnv;
let admin: { cookie: string; csrf: string };
let bob: { cookie: string; csrf: string };

async function login(email: string) {
  const r = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
  return { cookie: String(r.headers['set-cookie']).split(';')[0], csrf: r.json().csrf as string };
}

function upload(who: { cookie: string; csrf: string }, variant: string, data: Buffer, filename = 'logo.png') {
  const b = '----owlogo';
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return env.app.inject({
    method: 'POST',
    url: `/api/admin/branding/${variant}`,
    payload,
    headers: { cookie: who.cookie, 'x-csrf-token': who.csrf, 'content-type': `multipart/form-data; boundary=${b}` },
  });
}

const branding = async () => (await env.app.inject({ method: 'GET', url: '/branding' })).json();

beforeEach(async () => {
  env = await makeTestEnv();
  admin = await login('alice@example.com');
  bob = await login('bob@example.com');
});
afterEach(() => env.close());

describe('Branding', () => {
  it('ohne Logo: öffentlich abfragbar, keine Logos, 404 für die Datei', async () => {
    expect(await branding()).toEqual({ light: null, dark: null });
    expect((await env.app.inject({ method: 'GET', url: '/branding/logo/light' })).statusCode).toBe(404);
  });

  it('Admin lädt Logo hoch; ohne Login abrufbar; nur eine Variante gilt für beide', async () => {
    expect((await upload(admin, 'light', PNG)).statusCode).toBe(200);
    const b = await branding();
    expect(b.light).toMatch(/^\/branding\/logo\/light\?v=\d+$/);
    const f = await env.app.inject({ method: 'GET', url: b.light });
    const fallback = await env.app.inject({ method: 'GET', url: b.dark });
    expect(fallback.rawPayload.equals(PNG)).toBe(true);
    expect(f.statusCode).toBe(200);
    expect(f.headers['content-type']).toBe('image/png');
    expect(f.rawPayload.equals(PNG)).toBe(true);
  });

  it('getrennte Varianten; Ersetzen mit anderem Format; Entfernen', async () => {
    await upload(admin, 'light', PNG);
    await upload(admin, 'dark', SVG, 'logo.svg');
    const b = await branding();
    expect(b.dark).toMatch(/^\/branding\/logo\/dark/);
    await upload(admin, 'dark', PNG);
    const dir = path.join(env.config.dataDir, 'branding');
    expect((await fsp.readdir(dir)).sort()).toEqual(['logo-dark.png', 'logo-light.png']);
    const del = await env.app.inject({
      method: 'DELETE',
      url: '/api/admin/branding/dark',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(del.statusCode).toBe(200);
    expect((await fsp.readdir(dir))).toEqual(['logo-light.png']);
  });

  it('SVG wird in einer Sandbox ausgeliefert', async () => {
    await upload(admin, 'light', SVG, 'logo.svg');
    const f = await env.app.inject({ method: 'GET', url: '/branding/logo/light' });
    expect(f.headers['content-type']).toBe('image/svg+xml');
    expect(f.headers['content-security-policy']).toContain('sandbox');
    expect(f.headers['x-content-type-options']).toBe('nosniff');
  });

  it('lehnt Nicht-Bilder, falsche Varianten, zu große Dateien und normale Nutzer ab', async () => {
    expect((await upload(admin, 'light', Buffer.from('<html><script>alert(1)</script></html>'), 'logo.png')).statusCode).toBe(415);
    expect((await upload(admin, 'neon', PNG)).statusCode).toBe(400);
    expect((await upload(admin, 'light', Buffer.concat([PNG, Buffer.alloc(3 * 1024 * 1024)]))).statusCode).toBe(413);
    expect((await upload(bob, 'light', PNG)).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/branding/logo/..%2F..%2Fdb.sqlite' })).statusCode).toBe(404);
    expect(await branding()).toEqual({ light: null, dark: null });
  });

  it('von Hand ins Verzeichnis gelegte Logos werden erkannt', async () => {
    const dir = path.join(env.config.dataDir, 'branding');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'logo-dark.webp'), Buffer.from('RIFF0000WEBPVP8 '));
    const b = await branding();
    expect(b.dark).toMatch(/^\/branding\/logo\/dark/);
    expect((await env.app.inject({ method: 'GET', url: b.dark })).headers['content-type']).toBe('image/webp');
  });
});
