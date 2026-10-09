import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/knex.js';
import { VaultError } from '../vault/errors.js';
import { isHidden, joinVault, normalizeVaultPath, parentOf } from '../vault/paths.js';
import { searchVault } from '../vault/search.js';
import type { Vault, VaultStore } from '../vault/VaultService.js';

const pathQuery = z.object({ path: z.string() });
const saveBody = z.object({
  path: z.string().min(1),
  content: z.string(),
  etag: z.string().optional(), // zuletzt bekannter Stand; fehlt er, wird nur neu angelegt
  overwrite: z.boolean().optional(), // Konflikt bewusst überschreiben
});
const moveBody = z.object({ from: z.string().min(1), to: z.string().min(1) });
const mkdirBody = z.object({ path: z.string().min(1) });

export async function fileRoutes(app: FastifyInstance, opts: { db: Db; store: VaultStore; config: Config }) {
  const { db, store, config } = opts;
  const vaultOf = (userId: number) => store.forUser(userId);

  app.get('/api/tree', async (req) => {
    const vault = vaultOf(req.user!.id);
    const entries = await vault.indexedTree();
    return { entries: entries.filter((e) => !isHidden(e.path)) };
  });

  app.get('/api/file', async (req) => {
    const { path: p } = pathQuery.parse(req.query);
    const { entry, data } = await vaultOf(req.user!.id).readBuffer(p);
    return { path: entry.path, content: data.toString('utf8'), etag: entry.etag, mtimeMs: entry.mtimeMs };
  });

  app.put('/api/file', async (req) => {
    const body = saveBody.parse(req.body);
    const vault = vaultOf(req.user!.id);
    const { entry, created } = await vault.write(body.path, body.content, {
      ifMatch: body.overwrite ? undefined : body.etag,
      ifNoneMatch: !body.overwrite && body.etag === undefined,
    });
    return { path: entry.path, etag: entry.etag, mtimeMs: entry.mtimeMs, created };
  });

  app.delete('/api/file', async (req) => {
    const { path: p } = pathQuery.parse(req.query);
    await vaultOf(req.user!.id).delete(p);
    return { ok: true };
  });

  app.post('/api/move', async (req) => {
    const { from, to } = moveBody.parse(req.body);
    await vaultOf(req.user!.id).move(from, to, { overwrite: false, parents: true });
    return { ok: true, path: normalizeVaultPath(to) };
  });

  app.post('/api/mkdir', async (req) => {
    const { path: p } = mkdirBody.parse(req.body);
    const e = await vaultOf(req.user!.id).mkdir(p, { parents: true });
    return { path: e.path };
  });

  app.get('/api/search', async (req) => {
    const { q } = z.object({ q: z.string() }).parse(req.query);
    return { hits: await searchVault(db, req.user!.id, q) };
  });

  app.get('/api/raw', async (req, reply) => {
    const { path: p } = pathQuery.parse(req.query);
    const { entry, stream } = await vaultOf(req.user!.id).readStream(p);
    return reply
      .header('Content-Type', entry.mime ?? 'application/octet-stream')
      .header('Content-Length', String(entry.size))
      .header('ETag', `"${entry.etag}"`)
      .header('Cache-Control', 'private, no-cache')
      .header('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox")
      .header('X-Content-Type-Options', 'nosniff')
      .send(stream);
  });

  /** Upload von Anhängen; dir = Zielordner (Standard: ATTACHMENTS_DIR). Liefert den Vault-Pfad. */
  app.post('/api/attachments', async (req) => {
    const { dir } = z.object({ dir: z.string().optional() }).parse(req.query);
    const vault = vaultOf(req.user!.id);
    const targetDir = normalizeVaultPath(dir ?? config.attachmentsDir);
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) throw new VaultError('NOT_FOUND', 'Keine Datei übermittelt');
    const name = sanitizeFileName(file.filename || 'upload');
    const target = await freeName(vault, joinVault(targetDir, name));
    const { entry } = await vault.write(target, file.file, { ifNoneMatch: true });
    if (file.file.truncated) {
      await vault.delete(entry.path);
      throw new VaultError('TOO_LARGE', 'Datei zu groß');
    }
    return { path: entry.path, name: path.posix.basename(entry.path) };
  });
}

export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|#^[\]\0]/g, '-').replace(/^\.+/, '').trim();
  return cleaned || 'upload';
}

/** "bild.png" → "bild 1.png", "bild 2.png", … bis ein freier Name gefunden ist (wie Obsidian) */
async function freeName(vault: Vault, rel: string): Promise<string> {
  if (!(await vault.stat(rel))) return rel;
  const dir = parentOf(rel);
  const ext = path.posix.extname(rel);
  const stem = path.posix.basename(rel, ext);
  for (let i = 1; i < 1000; i++) {
    const candidate = joinVault(dir, `${stem} ${i}${ext}`);
    if (!(await vault.stat(candidate))) return candidate;
  }
  throw new VaultError('EXISTS', 'Kein freier Dateiname gefunden');
}
