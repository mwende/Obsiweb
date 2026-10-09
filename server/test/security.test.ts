import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parsePropfindBody } from '../src/dav/propfind.js';
import { makeTestEnv, PASSWORD, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await makeTestEnv();
});
afterEach(() => env.close());

const login = (email: string, password: string, xff?: string) =>
  env.app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
    headers: xff ? { 'x-forwarded-for': xff } : {},
  });

describe('Sicherheit', () => {
  it('setzt Sicherheits-Header; WebDAV-Dateien laufen in einer Sandbox', async () => {
    const r = await env.app.inject({ method: 'GET', url: '/auth/providers' });
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['content-security-policy']).toContain("script-src 'self'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');

    await env.store.forUser(env.alice.id).write('evil.html', '<script>alert(1)</script>');
    const f = await env.app.inject({ method: 'GET', url: '/dav/evil.html', headers: { authorization: env.aliceAuth } });
    expect(f.statusCode).toBe(200);
    expect(f.headers['content-security-policy']).toContain('sandbox');
    expect(f.headers['content-disposition']).toBe('attachment');
  });

  it('Login-Rate-Limit lässt sich nicht per gefälschtem X-Forwarded-For umgehen', async () => {
    // Nginx hängt die echte Client-IP rechts an; links steht, was der Client selbst schickt
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await login('alice@example.com', 'falsch', `10.0.0.${i}, 203.0.113.7`)).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 401)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
    // andere echte IP ist nicht betroffen
    expect((await login('alice@example.com', PASSWORD, '203.0.113.8')).statusCode).toBe(200);
  });

  it('WebDAV sperrt eine IP nach vielen Fehlversuchen', async () => {
    const bad = `Basic ${Buffer.from('alice@example.com:ow_falsch').toString('base64')}`;
    const h = { authorization: bad, 'x-forwarded-for': '198.51.100.1' };
    for (let i = 0; i < 30; i++) {
      expect((await env.app.inject({ method: 'PROPFIND', url: '/dav/', headers: h })).statusCode).toBe(401);
    }
    const blocked = await env.app.inject({ method: 'PROPFIND', url: '/dav/', headers: h });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // andere IP mit gültigem Zugang funktioniert weiter
    const ok = await env.app.inject({ method: 'PROPFIND', url: '/dav/', headers: { authorization: env.aliceAuth, depth: '0', 'x-forwarded-for': '198.51.100.2' } });
    expect(ok.statusCode).toBe(207);
  });

  it('CORS für Obsidian ohne Credentials-Freigabe; fremde Origins bekommen keine Freigabe', async () => {
    const pre = (origin: string) =>
      env.app.inject({ method: 'OPTIONS', url: '/dav/', headers: { origin, 'access-control-request-method': 'PROPFIND' } });
    const obs = await pre('app://obsidian.md');
    expect(obs.headers['access-control-allow-origin']).toBe('app://obsidian.md');
    expect(obs.headers['access-control-allow-credentials']).toBeUndefined();
    expect((await pre('https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('Passwortwechsel meldet andere Sitzungen ab', async () => {
    const a = await login('alice@example.com', PASSWORD);
    const b = await login('alice@example.com', PASSWORD);
    const cookie = (r: typeof a) => String(r.headers['set-cookie']).split(';')[0];
    const r = await env.app.inject({
      method: 'POST',
      url: '/api/me/password',
      payload: { current: PASSWORD, next: 'ein-neues-langes-passwort' },
      headers: { cookie: cookie(a), 'x-csrf-token': a.json().csrf },
    });
    expect(r.statusCode).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookie(a) } })).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: '/api/me', headers: { cookie: cookie(b) } })).statusCode).toBe(401);
  });

  it('XML-Parser löst keine Entities auf', () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE d [<!ENTITY a "aaaaaaaaaa">]><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/></d:prop></d:propfind>';
    expect(parsePropfindBody(xml)).toEqual({ kind: 'prop', names: ['getetag'] });
  });

  it('Pfad-Traversal und fremde Vaults über die API sind gesperrt', async () => {
    const a = await login('bob@example.com', PASSWORD);
    const cookie = String(a.headers['set-cookie']).split(';')[0];
    for (const p of ['../1/geheim.md', '../../db.sqlite', '/../../etc/passwd', 'a/../../x']) {
      const r = await env.app.inject({ method: 'GET', url: `/api/file?path=${encodeURIComponent(p)}`, headers: { cookie } });
      expect(r.statusCode, p).toBe(400);
    }
    const up = await env.app.inject({
      method: 'POST',
      url: '/api/attachments?dir=' + encodeURIComponent('../1'),
      headers: { cookie, 'x-csrf-token': a.json().csrf, 'content-type': 'multipart/form-data; boundary=x' },
      payload: '--x\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\n\r\nhi\r\n--x--\r\n',
    });
    expect(up.statusCode).toBe(400);
  });
});
