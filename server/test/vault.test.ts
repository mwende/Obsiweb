import fsp from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { searchVault } from '../src/vault/search.js';
import type { Vault } from '../src/vault/VaultService.js';
import { makeTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let vault: Vault;
beforeEach(async () => {
  env = await makeTestEnv();
  vault = env.store.forUser(env.alice.id);
});
afterEach(() => env.close());

describe('VaultService', () => {
  it('schreibt, liest und legt Elternordner an', async () => {
    const { entry, created } = await vault.write('Projekte/Alpha/Plan.md', '# Plan');
    expect(created).toBe(true);
    expect(entry.size).toBe(6);
    expect((await vault.readBuffer('Projekte/Alpha/Plan.md')).data.toString()).toBe('# Plan');
    const tree = await vault.indexedTree();
    expect(tree.map((e) => e.path)).toEqual(['Projekte', 'Projekte/Alpha', 'Projekte/Alpha/Plan.md']);
  });

  it('ETag ändert sich mit dem Inhalt und schützt vor Überschreiben', async () => {
    const a = await vault.write('n.md', 'eins');
    const b = await vault.write('n.md', 'zwei', { ifMatch: a.entry.etag });
    expect(b.entry.etag).not.toBe(a.entry.etag);
    expect(b.created).toBe(false);
    await expect(vault.write('n.md', 'drei', { ifMatch: a.entry.etag })).rejects.toMatchObject({
      code: 'PRECONDITION',
      currentEtag: b.entry.etag,
    });
    await expect(vault.write('n.md', 'x', { ifNoneMatch: true })).rejects.toMatchObject({ code: 'EXISTS' });
  });

  it('erkennt Änderungen von außen über reconcile', async () => {
    await vault.write('a.md', 'alt');
    await vault.write('b.md', 'weg');
    await fsp.writeFile(vault.abs('a.md'), 'neu und länger');
    await fsp.rm(vault.abs('b.md'));
    await fsp.writeFile(vault.abs('c.md'), 'extern');
    const r = await vault.reconcile();
    expect(r).toEqual({ updated: 2, removed: 1 });
    const hits = await searchVault(env.db, env.alice.id, 'länger');
    expect(hits.map((h) => h.path)).toEqual(['a.md']);
  });

  it('verschiebt Ordner samt Index, ohne Ordner mit gleichem Präfix zu berühren', async () => {
    await vault.write('Alt/x.md', 'x');
    await vault.write('Altbau/y.md', 'y');
    await vault.write('Alt_/z.md', 'z'); // "_" ist LIKE-Platzhalter
    await vault.move('Alt', 'Neu/Tief', { parents: true });
    const paths = (await vault.indexedTree()).map((e) => e.path);
    expect(paths).toEqual(['Alt_', 'Alt_/z.md', 'Altbau', 'Altbau/y.md', 'Neu', 'Neu/Tief', 'Neu/Tief/x.md']);
  });

  it('kopiert und löscht rekursiv', async () => {
    await vault.write('A/1.md', '1');
    await vault.copy('A', 'B');
    await vault.delete('A');
    expect((await vault.indexedTree()).map((e) => e.path)).toEqual(['B', 'B/1.md']);
    await expect(vault.delete('')).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('verhindert Verschieben in sich selbst und Überschreiben ohne Erlaubnis', async () => {
    await vault.write('A/1.md', '1');
    await vault.write('B.md', 'b');
    await expect(vault.move('A', 'A/sub')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(vault.move('B.md', 'A/1.md', { overwrite: false })).rejects.toMatchObject({ code: 'EXISTS' });
  });

  it('isoliert Vaults verschiedener Nutzer', async () => {
    await vault.write('geheim.md', 'alice');
    const bobVault = env.store.forUser(env.bob.id);
    expect(await bobVault.stat('geheim.md')).toBeNull();
    expect(await searchVault(env.db, env.bob.id, 'alice')).toEqual([]);
  });

  it('Suche findet Inhalt und Pfad, ignoriert versteckte Dateien', async () => {
    await vault.write('Rezepte/Pizza.md', 'Teig mit Hefe und Tomaten');
    await vault.write('.obsidian/workspace.md', 'Hefe');
    expect((await searchVault(env.db, env.alice.id, 'hefe tomaten')).map((h) => h.path)).toEqual(['Rezepte/Pizza.md']);
    expect((await searchVault(env.db, env.alice.id, 'pizza')).map((h) => h.path)).toEqual(['Rezepte/Pizza.md']);
    expect((await searchVault(env.db, env.alice.id, '100%')).length).toBe(0);
  });

  it('serialisiert parallele Schreibzugriffe mit If-Match (genau einer gewinnt)', async () => {
    const { entry } = await vault.write('race.md', 'start');
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, (_, i) => vault.write('race.md', `v${i}`, { ifMatch: entry.etag })),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
