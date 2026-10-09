import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type FileStat, type WebDAVClient } from 'webdav';
import { pathFromUrl } from '../src/dav/server.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let client: WebDAVClient;
let base: string;

beforeAll(async () => {
  env = await makeTestEnv();
  await env.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(env.app.server.address() as AddressInfo).port}`;
  client = createClient(`${base}/dav`, { username: 'alice@example.com', password: env.aliceToken });
});
afterAll(() => env.close());

describe('WebDAV mit webdav-Client', () => {
  it('Upload, Listing, Download (inkl. Umlaute und Leerzeichen)', async () => {
    await client.createDirectory('/Notizen');
    await client.putFileContents('/Notizen/Größe & Maß.md', '# Hallo Welt');
    const list = (await client.getDirectoryContents('/Notizen')) as FileStat[];
    expect(list.map((f) => f.basename)).toEqual(['Größe & Maß.md']);
    expect(list[0].size).toBe(12);
    expect(list[0].etag).toBeTruthy();
    expect(await client.getFileContents('/Notizen/Größe & Maß.md', { format: 'text' })).toBe('# Hallo Welt');
  });

  it('Depth infinity listet rekursiv', async () => {
    await client.putFileContents('/Tief/a/b/c.md', 'c');
    const list = (await client.getDirectoryContents('/Tief', { deep: true })) as FileStat[];
    expect(list.map((f) => f.filename).sort()).toEqual(['/Tief/a', '/Tief/a/b', '/Tief/a/b/c.md']);
  });

  it('Move, Copy, Delete, stat', async () => {
    await client.putFileContents('/m.md', 'move me');
    await client.moveFile('/m.md', '/Notizen/m2.md');
    await client.copyFile('/Notizen/m2.md', '/kopie.md');
    expect((await client.stat('/kopie.md')) as FileStat).toMatchObject({ type: 'file', size: 7 });
    await client.deleteFile('/Notizen');
    expect(await client.exists('/Notizen/m2.md')).toBe(false);
    expect(await client.exists('/kopie.md')).toBe(true);
  });

  it('Binärdateien bleiben byte-identisch', async () => {
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
    await client.putFileContents('/attachments/bild.png', bytes);
    const back = (await client.getFileContents('/attachments/bild.png')) as ArrayBuffer;
    expect(Buffer.from(back).equals(bytes)).toBe(true);
  });
});

describe('WebDAV-Protokolldetails', () => {
  it('verlangt Authentifizierung, OPTIONS ist frei', async () => {
    const r = await env.app.inject({ method: 'PROPFIND', url: '/dav/' });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toContain('Basic');
    const o = await env.app.inject({ method: 'OPTIONS', url: '/dav/', headers: { origin: 'app://obsidian.md' } });
    expect(o.statusCode).toBe(200);
    expect(o.headers.dav).toBe('1');
    expect(o.headers['access-control-allow-origin']).toBe('app://obsidian.md');
  });

  it('falsches App-Passwort und Login-Passwort werden abgelehnt', async () => {
    const pw = `Basic ${Buffer.from('alice@example.com:correct horse battery').toString('base64')}`;
    const r = await env.app.inject({ method: 'PROPFIND', url: '/dav/', headers: { authorization: pw } });
    expect(r.statusCode).toBe(401);
  });

  it('Nutzer sehen nur ihren eigenen Vault', async () => {
    await env.app.inject({ method: 'PUT', url: '/dav/privat.md', headers: { authorization: env.aliceAuth }, payload: 'x' });
    const r = await env.app.inject({ method: 'GET', url: '/dav/privat.md', headers: { authorization: env.bobAuth } });
    expect(r.statusCode).toBe(404);
  });

  it('PUT mit If-Match und X-OC-Mtime', async () => {
    const h = { authorization: env.aliceAuth };
    const put = await env.app.inject({ method: 'PUT', url: '/dav/etag.md', headers: { ...h, 'x-oc-mtime': '1700000000' }, payload: 'eins' });
    expect(put.statusCode).toBe(201);
    expect(put.headers['x-oc-mtime']).toBe('accepted');
    const etag = put.headers.etag as string;
    const head = await env.app.inject({ method: 'HEAD', url: '/dav/etag.md', headers: h });
    expect(head.headers['last-modified']).toBe(new Date(1700000000 * 1000).toUTCString());
    expect(head.headers.etag).toBe(etag);
    const ok = await env.app.inject({ method: 'PUT', url: '/dav/etag.md', headers: { ...h, 'if-match': etag }, payload: 'zwei' });
    expect(ok.statusCode).toBe(204);
    const stale = await env.app.inject({ method: 'PUT', url: '/dav/etag.md', headers: { ...h, 'if-match': etag }, payload: 'drei' });
    expect(stale.statusCode).toBe(412);
  });

  it('MKCOL-Fehlerfälle und Traversal', async () => {
    const h = { authorization: env.aliceAuth };
    expect((await env.app.inject({ method: 'MKCOL', url: '/dav/fehlt/neu', headers: h })).statusCode).toBe(409);
    expect((await env.app.inject({ method: 'MKCOL', url: '/dav/x', headers: h })).statusCode).toBe(201);
    expect((await env.app.inject({ method: 'MKCOL', url: '/dav/x', headers: h })).statusCode).toBe(405);
    // Remotely Save schickt bei MKCOL einen Body mit → muss trotzdem funktionieren
    const withBody = await env.app.inject({ method: 'MKCOL', url: '/dav/mit-body', headers: { ...h, 'content-type': 'text/plain' }, payload: ' ' });
    expect(withBody.statusCode).toBe(201);
    expect([400, 404]).toContain((await env.app.inject({ method: 'GET', url: '/dav/%2e%2e/%2e%2e/etc/passwd', headers: h })).statusCode);
    expect(() => pathFromUrl('/dav/%2e%2e/etc/passwd')).toThrow();
    expect(() => pathFromUrl('/dav/a/%2E%2E/%2E%2E/b')).toThrow();
    expect(pathFromUrl('/dav/Ordner/Gr%C3%B6%C3%9Fe%20%26%20Ma%C3%9F.md?x=1')).toBe('Ordner/Größe & Maß.md');
    expect((await env.app.inject({ method: 'GET', url: '/dav/a%2Fb', headers: h })).statusCode).toBe(400);
  });

  it('ignoriert ungültige Content-Type-Header (Obsidian/Remotely Save)', async () => {
    const h = { authorization: env.aliceAuth, depth: '1' };
    for (const ct of ['xml', ';', 'text/xml']) {
      const r = await env.app.inject({ method: 'PROPFIND', url: '/dav/', headers: { ...h, 'content-type': ct }, payload: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:allprop/></d:propfind>' });
      expect(r.statusCode, ct).toBe(207);
    }
    const put = await env.app.inject({ method: 'PUT', url: '/dav/ct.md', headers: { authorization: env.aliceAuth, 'content-type': 'markdown' }, payload: '# ok' });
    expect(put.statusCode).toBe(201);
  });

  it('PROPFIND mit expliziten Properties liefert 404 für unbekannte', async () => {
    const body = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:quota-used-bytes/></d:prop></d:propfind>';
    const r = await env.app.inject({ method: 'PROPFIND', url: '/dav/', headers: { authorization: env.aliceAuth, depth: '0' }, payload: body });
    expect(r.statusCode).toBe(207);
    expect(r.body).toContain('<D:getetag>');
    expect(r.body).toContain('<D:quota-used-bytes/></D:prop><D:status>HTTP/1.1 404 Not Found');
  });

  it('MOVE ohne Overwrite auf existierendes Ziel → 412', async () => {
    const h = { authorization: env.aliceAuth };
    await env.app.inject({ method: 'PUT', url: '/dav/q.md', headers: h, payload: 'q' });
    await env.app.inject({ method: 'PUT', url: '/dav/z.md', headers: h, payload: 'z' });
    const r = await env.app.inject({ method: 'MOVE', url: '/dav/q.md', headers: { ...h, destination: `${base}/dav/z.md`, overwrite: 'F' } });
    expect(r.statusCode).toBe(412);
    const r2 = await env.app.inject({ method: 'MOVE', url: '/dav/q.md', headers: { ...h, destination: '/dav/z.md' } });
    expect(r2.statusCode).toBe(204);
  });

  it('Upload über Größenlimit → 413', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024);
    const r = await env.app.inject({ method: 'PUT', url: '/dav/gross.bin', headers: { authorization: env.aliceAuth }, payload: big });
    expect(r.statusCode).toBe(413);
  });
});
