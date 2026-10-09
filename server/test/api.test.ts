import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestEnv, PASSWORD, type TestEnv } from './helpers.js';

let env: TestEnv;
let cookie: string;
let csrf: string;

async function login(email: string) {
  const r = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
  expect(r.statusCode).toBe(200);
  return { cookie: String(r.headers['set-cookie']).split(';')[0], csrf: r.json().csrf as string };
}

const api = (method: string, url: string, payload?: unknown, extra: Record<string, string> = {}) =>
  env.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, 'x-csrf-token': csrf, ...extra } });

beforeAll(async () => {
  env = await makeTestEnv();
  ({ cookie, csrf } = await login('Alice@Example.com'));
});
afterAll(() => env.close());

describe('Auth', () => {
  it('lehnt falsche Passwörter ab', async () => {
    const r = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'alice@example.com', password: 'falsch' } });
    expect(r.statusCode).toBe(401);
  });
  it('ohne Session 401, ohne CSRF-Token 403', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/api/tree' })).statusCode).toBe(401);
    const r = await env.app.inject({ method: 'POST', url: '/api/mkdir', payload: { path: 'x' }, headers: { cookie } });
    expect(r.statusCode).toBe(403);
  });
  it('liefert Provider ohne Entra', async () => {
    expect((await env.app.inject({ method: 'GET', url: '/auth/providers' })).json()).toEqual({ local: true, entra: false });
  });
});

describe('Dateien', () => {
  it('anlegen, lesen, speichern mit Konflikterkennung', async () => {
    const created = await api('PUT', '/api/file', { path: 'Tagebuch/heute.md', content: 'Erster Eintrag' });
    expect(created.statusCode).toBe(200);
    const { etag } = created.json();
    // erneutes Anlegen ohne etag → existiert bereits
    expect((await api('PUT', '/api/file', { path: 'Tagebuch/heute.md', content: 'x' })).statusCode).toBe(412);
    const saved = await api('PUT', '/api/file', { path: 'Tagebuch/heute.md', content: 'Zweiter', etag });
    expect(saved.statusCode).toBe(200);
    const conflict = await api('PUT', '/api/file', { path: 'Tagebuch/heute.md', content: 'Dritter', etag });
    expect(conflict.statusCode).toBe(412);
    expect(conflict.json()).toMatchObject({ code: 'PRECONDITION', currentEtag: saved.json().etag });
    const forced = await api('PUT', '/api/file', { path: 'Tagebuch/heute.md', content: 'Dritter', overwrite: true });
    expect(forced.statusCode).toBe(200);
    const read = await api('GET', '/api/file?path=' + encodeURIComponent('Tagebuch/heute.md'));
    expect(read.json()).toMatchObject({ content: 'Dritter', etag: forced.json().etag });
  });

  it('Baum blendet .obsidian aus', async () => {
    await env.store.forUser(env.alice.id).write('.obsidian/app.json', '{}');
    const tree = (await api('GET', '/api/tree')).json().entries.map((e: any) => e.path);
    expect(tree).toContain('Tagebuch/heute.md');
    expect(tree.some((p: string) => p.startsWith('.obsidian'))).toBe(false);
  });

  it('verschieben, Ordner anlegen, suchen, löschen', async () => {
    expect((await api('POST', '/api/mkdir', { path: 'Archiv/2026' })).statusCode).toBe(200);
    expect((await api('POST', '/api/move', { from: 'Tagebuch/heute.md', to: 'Archiv/2026/heute.md' })).statusCode).toBe(200);
    const hits = (await api('GET', '/api/search?q=dritter')).json().hits;
    expect(hits).toEqual([{ path: 'Archiv/2026/heute.md', snippet: 'Dritter' }]);
    expect((await api('DELETE', '/api/file?path=Archiv')).statusCode).toBe(200);
    expect((await api('GET', '/api/search?q=dritter')).json().hits).toEqual([]);
  });

  it('Anhänge hochladen mit freiem Dateinamen und ausliefern', async () => {
    const boundary = '----owtest';
    const body = (name: string) =>
      Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: image/png\r\n\r\n`),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
    const up = (name: string) =>
      api('POST', '/api/attachments', body(name), { 'content-type': `multipart/form-data; boundary=${boundary}` });
    expect((await up('Bild.png')).json()).toEqual({ path: 'attachments/Bild.png', name: 'Bild.png' });
    expect((await up('Bild.png')).json()).toEqual({ path: 'attachments/Bild 1.png', name: 'Bild 1.png' });
    const raw = await api('GET', '/api/raw?path=' + encodeURIComponent('attachments/Bild 1.png'));
    expect(raw.headers['content-type']).toBe('image/png');
    expect(raw.rawPayload.length).toBe(4);
  });

  it('App-Passwörter verwalten; Widerruf wirkt sofort auf WebDAV', async () => {
    const created = (await api('POST', '/api/app-passwords', { label: 'iPhone' })).json();
    const auth = `Basic ${Buffer.from(`alice@example.com:${created.token}`).toString('base64')}`;
    expect((await env.app.inject({ method: 'PROPFIND', url: '/dav/', headers: { authorization: auth, depth: '0' } })).statusCode).toBe(207);
    const list = (await api('GET', '/api/app-passwords')).json().items;
    expect(list.map((i: any) => i.label)).toEqual(['test', 'iPhone']);
    expect(JSON.stringify(list)).not.toContain(created.token);
    expect((await api('DELETE', `/api/app-passwords/${created.id}`)).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'PROPFIND', url: '/dav/', headers: { authorization: auth, depth: '0' } })).statusCode).toBe(401);
  });
});

describe('Admin', () => {
  it('Admin legt Nutzer an, normale Nutzer dürfen nicht', async () => {
    const r = await api('POST', '/api/admin/users', { email: 'carol@example.com', displayName: 'Carol', password: 'langes-passwort-123' });
    expect(r.statusCode).toBe(200);
    const bob = await login('bob@example.com');
    const forbidden = await env.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: bob.cookie } });
    expect(forbidden.statusCode).toBe(403);
  });
});
