import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import mime from 'mime-types';
import type { Db } from '../db/knex.js';
import { VaultError } from './errors.js';
import { baseName, isIndexableText, isWithin, normalizeVaultPath, parentOf, toAbsolute } from './paths.js';

export interface Entry {
  path: string; // vault-relativ, '' = Wurzel
  isDir: boolean;
  size: number;
  mtimeMs: number;
  etag: string; // ohne Anführungszeichen
  mime: string | null;
}

export interface WriteOptions {
  /** ETag, den der Client zuletzt gesehen hat (ohne Anführungszeichen). Abweichung → PRECONDITION */
  ifMatch?: string;
  /** Datei darf noch nicht existieren */
  ifNoneMatch?: boolean;
  /** Änderungszeit setzen (z.B. X-OC-Mtime) */
  mtimeMs?: number;
}

interface IndexRow {
  path: string;
  is_dir: number | boolean;
  size: number;
  mtime_ms: number;
  etag: string | null;
}

const MAX_INDEXED_CONTENT = 2 * 1024 * 1024;

const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const etagOf = (hash: crypto.Hash) => hash.digest('hex').slice(0, 40);
const dirEtag = (mtimeMs: number) => `d-${Math.floor(mtimeMs).toString(16)}`;

export function stripEtag(v: string): string {
  return v.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
}

/** Serialisiert die kritischen Abschnitte (Prüfen + Umbenennen + Index) pro Nutzer. */
class KeyedMutex {
  private tails = new Map<string, Promise<void>>();
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => next);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export class VaultStore {
  private mutex = new KeyedMutex();
  readonly tmpDir: string;

  constructor(
    readonly db: Db,
    readonly dataDir: string,
    readonly maxUploadBytes: number,
  ) {
    this.tmpDir = path.join(dataDir, 'tmp');
  }

  async init(): Promise<void> {
    await fsp.mkdir(path.join(this.dataDir, 'vaults'), { recursive: true });
    await fsp.mkdir(this.tmpDir, { recursive: true });
  }

  forUser(userId: number): Vault {
    return new Vault(this, userId, path.join(this.dataDir, 'vaults', String(userId)));
  }

  lock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(String(userId), fn);
  }
}

export class Vault {
  constructor(
    private readonly store: VaultStore,
    readonly userId: number,
    readonly root: string,
  ) {}

  private get db() {
    return this.store.db;
  }

  abs(rel: string): string {
    return toAbsolute(this.root, rel);
  }

  async ensureRoot(): Promise<void> {
    await fsp.mkdir(this.root, { recursive: true });
  }

  // ---------------------------------------------------------------- Lesen

  async stat(rel: string): Promise<Entry | null> {
    rel = normalizeVaultPath(rel);
    await this.ensureRoot();
    const st = await statOrNull(this.abs(rel));
    if (!st) return null;
    const cached = st.isDirectory() ? null : await this.indexRow(rel);
    return this.toEntry(rel, st, cached);
  }

  async mustStat(rel: string): Promise<Entry> {
    const e = await this.stat(rel);
    if (!e) throw new VaultError('NOT_FOUND', `Nicht gefunden: ${rel}`);
    return e;
  }

  /** Listet `rel` selbst plus Kinder (depth 1) bzw. alle Nachfahren (Infinity). */
  async list(rel: string, depth: 0 | 1 | number): Promise<Entry[]> {
    rel = normalizeVaultPath(rel);
    const self = await this.mustStat(rel);
    const out: Entry[] = [self];
    if (!self.isDir || depth === 0) return out;
    const cache = await this.indexMap(rel);
    const walk = async (dir: string, level: number) => {
      const dirents = await fsp.readdir(this.abs(dir), { withFileTypes: true });
      for (const d of dirents) {
        if (!d.isFile() && !d.isDirectory()) continue;
        const childRel = dir ? `${dir}/${d.name}` : d.name;
        const st = await statOrNull(this.abs(childRel));
        if (!st) continue;
        out.push(await this.toEntry(childRel, st, cache.get(childRel) ?? null));
        if (st.isDirectory() && level < depth) await walk(childRel, level + 1);
      }
    };
    await walk(rel, 1);
    return out;
  }

  async readBuffer(rel: string): Promise<{ entry: Entry; data: Buffer }> {
    const entry = await this.mustStat(rel);
    if (entry.isDir) throw new VaultError('IS_DIR', 'Ist ein Ordner');
    return { entry, data: await fsp.readFile(this.abs(entry.path)) };
  }

  async readStream(rel: string): Promise<{ entry: Entry; stream: fs.ReadStream }> {
    const entry = await this.mustStat(rel);
    if (entry.isDir) throw new VaultError('IS_DIR', 'Ist ein Ordner');
    return { entry, stream: fs.createReadStream(this.abs(entry.path)) };
  }

  // ---------------------------------------------------------------- Schreiben

  /** Schreibt eine Datei atomar (Temp-Datei + rename). Fehlende Elternordner werden angelegt. */
  async write(
    rel: string,
    source: Buffer | string | Readable,
    opts: WriteOptions = {},
  ): Promise<{ entry: Entry; created: boolean }> {
    rel = normalizeVaultPath(rel);
    if (rel === '') throw new VaultError('IS_DIR', 'Die Vault-Wurzel ist ein Ordner');
    await this.ensureRoot();

    // 1) Inhalt außerhalb des Locks in eine Temp-Datei streamen und dabei hashen
    const tmp = path.join(this.store.tmpDir, `${crypto.randomUUID()}.part`);
    const hash = crypto.createHash('sha1');
    let size = 0;
    const max = this.store.maxUploadBytes;
    const meter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length;
        if (size > max) return cb(new VaultError('TOO_LARGE', 'Datei zu groß'));
        hash.update(chunk);
        cb(null, chunk);
      },
    });
    const input = typeof source === 'string' || Buffer.isBuffer(source) ? Readable.from([Buffer.from(source)]) : source;
    try {
      await pipeline(input, meter, fs.createWriteStream(tmp));
    } catch (err) {
      await fsp.rm(tmp, { force: true });
      throw err;
    }
    const newEtag = etagOf(hash);

    // 2) Prüfen + Verschieben + Index unter Lock
    try {
      return await this.store.lock(this.userId, async () => {
        const target = this.abs(rel);
        const st = await statOrNull(target);
        if (st?.isDirectory()) throw new VaultError('IS_DIR', 'Ziel ist ein Ordner');
        if (st && opts.ifNoneMatch) throw new VaultError('EXISTS', 'Datei existiert bereits');
        if (opts.ifMatch !== undefined) {
          const current = st ? (await this.toEntry(rel, st, await this.indexRow(rel))).etag : null;
          if (current !== stripEtag(opts.ifMatch)) {
            throw new VaultError('PRECONDITION', 'Datei wurde zwischenzeitlich geändert', current);
          }
        }
        await this.mkdirsLocked(parentOf(rel));
        await fsp.rename(tmp, target);
        if (opts.mtimeMs !== undefined) {
          const t = new Date(opts.mtimeMs);
          await fsp.utimes(target, t, t);
        }
        const nst = await fsp.stat(target);
        const entry: Entry = {
          path: rel,
          isDir: false,
          size: nst.size,
          mtimeMs: Math.floor(nst.mtimeMs),
          etag: newEtag,
          mime: mimeOf(rel),
        };
        await this.upsertIndex(entry, await this.textContent(rel, nst.size));
        await this.touchParents(rel);
        return { entry, created: !st };
      });
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  async mkdir(rel: string, opts: { parents?: boolean } = {}): Promise<Entry> {
    rel = normalizeVaultPath(rel);
    await this.ensureRoot();
    return this.store.lock(this.userId, async () => {
      if (rel === '' || (await statOrNull(this.abs(rel)))) throw new VaultError('EXISTS', 'Existiert bereits');
      const parent = parentOf(rel);
      const pst = await statOrNull(this.abs(parent));
      if (!pst) {
        if (!opts.parents) throw new VaultError('PARENT_MISSING', 'Übergeordneter Ordner fehlt');
      } else if (!pst.isDirectory()) throw new VaultError('NOT_DIR', 'Übergeordneter Pfad ist eine Datei');
      await this.mkdirsLocked(rel);
      await this.touchParents(rel);
      return this.mustStat(rel);
    });
  }

  async delete(rel: string): Promise<void> {
    rel = normalizeVaultPath(rel);
    if (rel === '') throw new VaultError('FORBIDDEN', 'Die Vault-Wurzel kann nicht gelöscht werden');
    await this.store.lock(this.userId, async () => {
      const abs = this.abs(rel);
      if (!(await statOrNull(abs))) throw new VaultError('NOT_FOUND', `Nicht gefunden: ${rel}`);
      await fsp.rm(abs, { recursive: true, force: true });
      await this.deleteIndexSubtree(rel);
      await this.touchParents(rel);
    });
  }

  async move(from: string, to: string, opts: { overwrite?: boolean; parents?: boolean } = {}): Promise<{ created: boolean }> {
    from = normalizeVaultPath(from);
    to = normalizeVaultPath(to);
    if (from === '' || to === '') throw new VaultError('FORBIDDEN', 'Die Vault-Wurzel kann nicht verschoben werden');
    if (from === to) throw new VaultError('FORBIDDEN', 'Quelle und Ziel sind identisch');
    if (isWithin(to, from)) throw new VaultError('FORBIDDEN', 'Ein Ordner kann nicht in sich selbst verschoben werden');
    return this.store.lock(this.userId, async () => {
      const src = await statOrNull(this.abs(from));
      if (!src) throw new VaultError('NOT_FOUND', `Nicht gefunden: ${from}`);
      const existed = await this.prepareTargetLocked(to, opts);
      await fsp.rename(this.abs(from), this.abs(to));
      await this.renameIndexSubtree(from, to);
      await this.touchParents(from);
      await this.touchParents(to);
      return { created: !existed };
    });
  }

  async copy(from: string, to: string, opts: { overwrite?: boolean; parents?: boolean } = {}): Promise<{ created: boolean }> {
    from = normalizeVaultPath(from);
    to = normalizeVaultPath(to);
    if (to === '') throw new VaultError('FORBIDDEN', 'Ziel ungültig');
    if (isWithin(to, from)) throw new VaultError('FORBIDDEN', 'Ein Ordner kann nicht in sich selbst kopiert werden');
    return this.store.lock(this.userId, async () => {
      const src = await statOrNull(this.abs(from));
      if (!src) throw new VaultError('NOT_FOUND', `Nicht gefunden: ${from}`);
      const existed = await this.prepareTargetLocked(to, opts);
      await fsp.cp(this.abs(from), this.abs(to), { recursive: true, preserveTimestamps: true });
      await this.reindexSubtreeLocked(to);
      await this.touchParents(to);
      return { created: !existed };
    });
  }

  /** Gleicht den Index mit dem Dateisystem ab (Start, manuell, nach Änderungen von außen). */
  async reconcile(): Promise<{ updated: number; removed: number }> {
    await this.ensureRoot();
    return this.store.lock(this.userId, () => this.reindexSubtreeLocked(''));
  }

  // ---------------------------------------------------------------- Abfragen auf dem Index

  async indexedTree(): Promise<Array<{ path: string; isDir: boolean; size: number; mtimeMs: number }>> {
    const rows: IndexRow[] = await this.db('files')
      .where({ user_id: this.userId })
      .select('path', 'is_dir', 'size', 'mtime_ms', 'etag')
      .orderBy('path');
    return rows.map((r) => ({ path: r.path, isDir: Boolean(r.is_dir), size: Number(r.size), mtimeMs: Number(r.mtime_ms) }));
  }

  // ---------------------------------------------------------------- intern

  private async prepareTargetLocked(to: string, opts: { overwrite?: boolean; parents?: boolean }): Promise<boolean> {
    const existing = await statOrNull(this.abs(to));
    if (existing) {
      if (opts.overwrite === false) throw new VaultError('EXISTS', 'Ziel existiert bereits');
      await fsp.rm(this.abs(to), { recursive: true, force: true });
      await this.deleteIndexSubtree(to);
    }
    const parent = parentOf(to);
    const pst = await statOrNull(this.abs(parent));
    if (!pst) {
      if (!opts.parents) throw new VaultError('PARENT_MISSING', 'Zielordner existiert nicht');
      await this.mkdirsLocked(parent);
    } else if (!pst.isDirectory()) throw new VaultError('NOT_DIR', 'Zielordner ist eine Datei');
    return Boolean(existing);
  }

  /** Legt `rel` inklusive aller Elternordner an und indiziert neu angelegte Ordner. */
  private async mkdirsLocked(rel: string): Promise<void> {
    if (rel === '') return;
    const segs = rel.split('/');
    for (let i = 1; i <= segs.length; i++) {
      const p = segs.slice(0, i).join('/');
      const st = await statOrNull(this.abs(p));
      if (st) {
        if (!st.isDirectory()) throw new VaultError('NOT_DIR', `Pfad ist eine Datei: ${p}`);
        continue;
      }
      await fsp.mkdir(this.abs(p));
      const nst = await fsp.stat(this.abs(p));
      await this.upsertIndex({ path: p, isDir: true, size: 0, mtimeMs: Math.floor(nst.mtimeMs), etag: dirEtag(nst.mtimeMs), mime: null }, null);
    }
  }

  /** Aktualisiert mtime der Elternordner im Index (Dateisystem hat sie bereits geändert). */
  private async touchParents(rel: string): Promise<void> {
    const parent = parentOf(rel);
    if (parent === '') return;
    const st = await statOrNull(this.abs(parent));
    if (!st) return;
    await this.db('files')
      .where({ user_id: this.userId, path_hash: sha256(parent) })
      .update({ mtime_ms: Math.floor(st.mtimeMs), etag: dirEtag(st.mtimeMs) });
  }

  private async toEntry(rel: string, st: fs.Stats, cached: IndexRow | null): Promise<Entry> {
    const mtimeMs = Math.floor(st.mtimeMs);
    if (st.isDirectory()) {
      return { path: rel, isDir: true, size: 0, mtimeMs, etag: dirEtag(st.mtimeMs), mime: null };
    }
    let etag = cached && Number(cached.size) === st.size && Number(cached.mtime_ms) === mtimeMs ? cached.etag : null;
    if (!etag) {
      // Index veraltet (Änderung von außen) → neu hashen und Index aktualisieren
      etag = await hashFile(this.abs(rel));
      await this.upsertIndex({ path: rel, isDir: false, size: st.size, mtimeMs, etag, mime: mimeOf(rel) }, await this.textContent(rel, st.size));
    }
    return { path: rel, isDir: false, size: st.size, mtimeMs, etag, mime: mimeOf(rel) };
  }

  private async textContent(rel: string, size: number): Promise<string | null> {
    if (!isIndexableText(rel) || size > MAX_INDEXED_CONTENT) return null;
    return fsp.readFile(this.abs(rel), 'utf8');
  }

  private async indexRow(rel: string): Promise<IndexRow | null> {
    const row = await this.db('files')
      .where({ user_id: this.userId, path_hash: sha256(rel) })
      .first('path', 'is_dir', 'size', 'mtime_ms', 'etag');
    return row ?? null;
  }

  /**
   * Index-Zeilen unterhalb von `prefix` (ohne `prefix` selbst, außer includeSelf).
   * LIKE ist in MySQL/SQLite nicht case-/akzentsensitiv → exakter Nachfilter in JS.
   */
  private async subtreeRows(prefix: string, includeSelf = false): Promise<Array<IndexRow & { id: number }>> {
    const q = this.db('files').where({ user_id: this.userId }).select('id', 'path', 'is_dir', 'size', 'mtime_ms', 'etag');
    if (prefix) {
      q.andWhere((w) => {
        w.whereRaw("path LIKE ? ESCAPE '!'", [`${escapeLike(prefix)}/%`]);
        if (includeSelf) w.orWhere('path_hash', sha256(prefix));
      });
    }
    const rows: Array<IndexRow & { id: number }> = await q;
    return rows.filter((r) => (includeSelf && r.path === prefix) || isWithin(r.path, prefix) && r.path !== prefix);
  }

  private async indexMap(prefix: string): Promise<Map<string, IndexRow>> {
    const rows = await this.subtreeRows(prefix);
    return new Map(rows.map((r) => [r.path, r]));
  }

  private async upsertIndex(e: Entry, content: string | null): Promise<void> {
    const row = {
      user_id: this.userId,
      path: e.path,
      path_hash: sha256(e.path),
      is_dir: e.isDir,
      size: e.size,
      mtime_ms: e.mtimeMs,
      etag: e.etag,
      mime: e.mime,
      content,
    };
    await this.db('files').insert(row).onConflict(['user_id', 'path_hash']).merge();
  }

  private async deleteIndexSubtree(rel: string): Promise<void> {
    const ids = (await this.subtreeRows(rel, true)).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 500) {
      await this.db('files').whereIn('id', ids.slice(i, i + 500)).delete();
    }
  }

  private async renameIndexSubtree(from: string, to: string): Promise<void> {
    const rows = await this.subtreeRows(from, true);
    await this.db.transaction(async (trx) => {
      for (const r of rows) {
        const np = to + r.path.slice(from.length);
        await trx('files')
          .where({ id: r.id })
          .update({ path: np, path_hash: sha256(np), mime: r.is_dir ? null : mimeOf(np) });
      }
    });
    // Der Inhaltsindex hängt von der Endung ab (z.B. .txt → .md); betroffene Wurzel neu bewerten
    const st = await statOrNull(this.abs(to));
    if (st?.isFile()) {
      await this.db('files')
        .where({ user_id: this.userId, path_hash: sha256(to) })
        .update({ content: await this.textContent(to, st.size) });
    }
  }

  private async reindexSubtreeLocked(rel: string): Promise<{ updated: number; removed: number }> {
    const cache = await this.indexMap(rel);
    const self = rel ? await this.indexRow(rel) : null;
    if (self) cache.set(rel, self);
    const seen = new Set<string>();
    let updated = 0;
    const visit = async (p: string) => {
      const st = await statOrNull(this.abs(p));
      if (!st) return;
      if (p !== '') {
        seen.add(p);
        const c = cache.get(p);
        if (st.isDirectory()) {
          if (!c || !c.is_dir) {
            await this.upsertIndex({ path: p, isDir: true, size: 0, mtimeMs: Math.floor(st.mtimeMs), etag: dirEtag(st.mtimeMs), mime: null }, null);
            updated++;
          }
        } else if (!c || Number(c.size) !== st.size || Number(c.mtime_ms) !== Math.floor(st.mtimeMs)) {
          await this.toEntry(p, st, null); // hasht und schreibt den Index
          updated++;
        }
      }
      if (st.isDirectory()) {
        for (const d of await fsp.readdir(this.abs(p), { withFileTypes: true })) {
          if (d.isFile() || d.isDirectory()) await visit(p ? `${p}/${d.name}` : d.name);
        }
      }
    };
    await visit(rel);
    const stale = [...cache.keys()].filter((p) => !seen.has(p));
    for (const p of stale) {
      await this.db('files').where({ user_id: this.userId, path_hash: sha256(p) }).delete();
    }
    return { updated, removed: stale.length };
  }
}

export function mimeOf(rel: string): string {
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'text/markdown; charset=utf-8';
  if (ext === '.canvas') return 'application/json';
  const m = mime.lookup(baseName(rel));
  if (!m) return 'application/octet-stream';
  return m.startsWith('text/') ? `${m}; charset=utf-8` : m;
}

async function statOrNull(abs: string): Promise<fs.Stats | null> {
  try {
    return await fsp.stat(abs);
  } catch (err: any) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return null;
    throw err;
  }
}

async function hashFile(abs: string): Promise<string> {
  const hash = crypto.createHash('sha1');
  await pipeline(fs.createReadStream(abs), async function* (src) {
    for await (const chunk of src) hash.update(chunk);
  });
  return etagOf(hash);
}

/** Escaped für `LIKE … ESCAPE '!'` (funktioniert identisch in MySQL und SQLite) */
export function escapeLike(s: string): string {
  return s.replace(/[!%_]/g, (c) => `!${c}`);
}
