import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { normalizeVaultPath } from '../src/vault/paths.js';
import { makeTestEnv, PASSWORD, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeEach(async () => {
  env = await makeTestEnv();
});
afterEach(() => env.close());

const login = async () => {
  const r = await env.app.inject({ method: 'POST', url: '/auth/login', payload: { email: 'alice@example.com', password: PASSWORD } });
  return { cookie: String(r.headers['set-cookie']).split(';')[0], csrf: r.json().csrf as string };
};

describe('Härtung', () => {
  it.each(['MOVE', 'COPY'])('%s auf den eigenen Elternordner löscht nichts', async (method) => {
    const v = env.store.forUser(env.alice.id);
    await v.write('Ordner/Sub/wichtig.md', 'daten');
    await v.write('Ordner/anderes.md', 'auch');
    const r = await env.app.inject({
      method: method as 'MOVE',
      url: '/dav/Ordner/Sub',
      headers: { authorization: env.aliceAuth, destination: '/dav/Ordner' },
    });
    expect(r.statusCode).toBe(403);
    expect((await v.readBuffer('Ordner/Sub/wichtig.md')).data.toString()).toBe('daten');
    expect((await v.readBuffer('Ordner/anderes.md')).data.toString()).toBe('auch');
  });

  it('Vaults sind nur für den App-Benutzer zugänglich', async () => {
    const mode = async (p: string) => ((await fsp.stat(p)).mode & 0o777).toString(8);
    expect(await mode(path.join(env.config.dataDir, 'vaults'))).toBe('700');
    expect(await mode(path.join(env.config.dataDir, 'tmp'))).toBe('700');
  });

  it('prüft die Anmeldung, bevor der Anfrageinhalt gelesen wird', async () => {
    const r = await env.app.inject({ method: 'PUT', url: '/api/file', headers: { 'content-type': 'application/json' }, payload: '{kaputt' });
    expect(r.statusCode).toBe(401);
  });

  it('private API-Antworten werden nicht zwischengespeichert', async () => {
    const { cookie } = await login();
    const r = await env.app.inject({ method: 'GET', url: '/api/tree', headers: { cookie } });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('Passwortwechsel ist gegen Raten begrenzt', async () => {
    const { cookie, csrf } = await login();
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await env.app.inject({
        method: 'POST',
        url: '/api/me/password',
        payload: { current: 'falsch', next: 'ein-neues-langes-passwort' },
        headers: { cookie, 'x-csrf-token': csrf },
      });
      codes.push(r.statusCode);
    }
    expect(codes.slice(0, 10).every((c) => c === 400)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('zu lange Pfade werden sauber abgelehnt, ohne Datei anzulegen', async () => {
    const long = `${Array.from({ length: 6 }, () => 'a'.repeat(200)).join('/')}/x.md`;
    expect(() => normalizeVaultPath(long)).toThrow();
    const r = await env.app.inject({ method: 'PUT', url: `/dav/${long}`, headers: { authorization: env.aliceAuth }, payload: 'a' });
    expect(r.statusCode).toBe(400);
  });
});
