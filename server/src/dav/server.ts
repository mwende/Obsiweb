import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BasicAuthVerifier } from '../auth/appPasswords.js';
import type { User } from '../auth/users.js';
import { VaultError, httpStatusFor } from '../vault/errors.js';
import { normalizeVaultPath } from '../vault/paths.js';
import { stripEtag, type Vault, type VaultStore } from '../vault/VaultService.js';
import { FailureLimiter } from '../security.js';
import { buildMultistatus, parsePropfindBody } from './propfind.js';

export const DAV_PREFIX = '/dav';
export const DAV_METHODS = ['OPTIONS', 'PROPFIND', 'PROPPATCH', 'GET', 'HEAD', 'PUT', 'DELETE', 'MKCOL', 'MOVE', 'COPY'] as const;

/** Origins, aus denen Obsidian (Desktop/Mobile) Anfragen stellt */
const OBSIDIAN_ORIGINS = new Set(['app://obsidian.md', 'capacitor://localhost', 'http://localhost', 'https://localhost']);

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': DAV_METHODS.join(', '),
  'Access-Control-Allow-Headers':
    'Authorization, Content-Type, Depth, Destination, Overwrite, If-Match, If-None-Match, X-OC-Mtime, Cache-Control, X-Requested-With',
  'Access-Control-Expose-Headers': 'DAV, ETag, Content-Length, Content-Type, Last-Modified, X-OC-MTime',
  'Access-Control-Max-Age': '86400',
};

declare module 'fastify' {
  interface FastifyRequest {
    davUser?: User;
  }
}

export interface DavOptions {
  store: VaultStore;
  basicAuth: BasicAuthVerifier;
  baseUrl: string;
  maxUploadBytes: number;
}

export async function davPlugin(app: FastifyInstance, opts: DavOptions) {
  const { store, basicAuth } = opts;
  const allowedOrigins = new Set([...OBSIDIAN_ORIGINS, new URL(opts.baseUrl).origin]);
  // 30 Fehlversuche pro IP und 15 Minuten, danach 429 bis Fensterende
  const failures = new FailureLimiter(30, 15 * 60_000);

  // Body wird pro Methode selbst als Stream gelesen
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', (_req, _payload, done) => done(null));

  app.addHook('onRequest', async (req, reply) => {
    // Bodies werden pro Methode selbst als Stream gelesen; der Content-Type spielt keine Rolle.
    // Fastify lehnt formal ungültige Werte (z.B. "xml" von Obsidian/Remotely Save) sonst mit 415 ab.
    const ct = req.headers['content-type'];
    if (ct !== undefined) {
      if (!/^[\w.+-]+\/[\w.+-]+/.test(ct)) req.log.info({ contentType: ct }, 'DAV: ungültiger Content-Type ersetzt');
      req.headers['content-type'] = 'application/octet-stream';
    }

    const origin = req.headers.origin;
    if (origin && allowedOrigins.has(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
      reply.headers(CORS_HEADERS);
    }
    if (req.method === 'OPTIONS') return; // ohne Authentifizierung (CORS-Preflight)

    const wait = failures.blockedFor(req.ip);
    if (wait) {
      return reply.code(429).header('Retry-After', String(wait)).send('Zu viele fehlgeschlagene Anmeldungen');
    }
    const user = await basicAuth.verify(req.headers.authorization);
    if (!user) {
      if (req.headers.authorization) failures.fail(req.ip);
      reply.header('WWW-Authenticate', 'Basic realm="ObsidianWEB", charset="UTF-8"');
      return reply.code(401).send('Authentifizierung erforderlich (E-Mail + App-Passwort)');
    }
    failures.succeed(req.ip);
    req.davUser = user;
  });

  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    try {
      const rel = pathFromUrl(req.url);
      if (req.method === 'OPTIONS') return options(reply);
      const vault = store.forUser(req.davUser!.id);
      switch (req.method) {
        case 'PROPFIND':
          return await propfind(req, reply, vault, rel);
        case 'PROPPATCH':
          return await proppatch(req, reply, vault, rel);
        case 'GET':
        case 'HEAD':
          return await get(req, reply, vault, rel);
        case 'PUT':
          return await put(req, reply, vault, rel, opts.maxUploadBytes);
        case 'DELETE':
          await vault.delete(rel);
          return reply.code(204).send();
        case 'MKCOL':
          return await mkcol(req, reply, vault, rel);
        case 'MOVE':
        case 'COPY':
          return await moveOrCopy(req, reply, vault, rel, opts.baseUrl);
        default:
          return reply.code(405).send();
      }
    } catch (err) {
      if (err instanceof VaultError) {
        let status = httpStatusFor(err.code);
        if (req.method === 'MKCOL' && err.code === 'EXISTS') status = 405;
        if (req.method === 'PUT' && err.code === 'IS_DIR') status = 405;
        return reply.code(status).type('text/plain; charset=utf-8').send(err.message);
      }
      throw err;
    }
  };

  for (const url of [DAV_PREFIX, `${DAV_PREFIX}/`, `${DAV_PREFIX}/*`]) {
    app.route({ method: [...DAV_METHODS], url, handler, exposeHeadRoute: false });
  }
}

/** Liest den vault-relativen Pfad aus der rohen URL (Segmente einzeln dekodiert). */
export function pathFromUrl(url: string): string {
  const pathname = url.split('?')[0];
  if (!pathname.startsWith(DAV_PREFIX)) throw new VaultError('BAD_PATH', 'Ungültiger DAV-Pfad');
  const rest = pathname.slice(DAV_PREFIX.length);
  let decoded: string[];
  try {
    decoded = rest.split('/').map((s) => decodeURIComponent(s));
  } catch {
    throw new VaultError('BAD_PATH', 'Ungültige URL-Kodierung');
  }
  if (decoded.some((s) => s.includes('/'))) throw new VaultError('BAD_PATH', 'Kodierter Schrägstrich im Pfad');
  return normalizeVaultPath(decoded.join('/'));
}

export function hrefFor(rel: string, isDir: boolean): string {
  const enc = rel ? rel.split('/').map(encodeURIComponent).join('/') : '';
  return `${DAV_PREFIX}/${enc}${isDir && enc ? '/' : ''}`;
}

function options(reply: FastifyReply) {
  return reply
    .code(200)
    .header('DAV', '1')
    .header('MS-Author-Via', 'DAV')
    .header('Allow', DAV_METHODS.join(', '))
    .header('Content-Length', '0')
    .send();
}

async function readBody(req: FastifyRequest, limit = 1024 * 1024): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.raw) {
    size += chunk.length;
    if (size > limit) throw new VaultError('TOO_LARGE', 'Anfrage zu groß');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

async function propfind(req: FastifyRequest, reply: FastifyReply, vault: Vault, rel: string) {
  const depthHeader = String(req.headers.depth ?? 'infinity').toLowerCase();
  const depth = depthHeader === '0' ? 0 : depthHeader === '1' ? 1 : Infinity;
  let request;
  try {
    request = parsePropfindBody((await readBody(req)).toString('utf8'));
  } catch {
    return reply.code(400).send('Ungültiges PROPFIND-XML');
  }
  const entries = await vault.list(rel, depth);
  return reply
    .code(207)
    .type('application/xml; charset=utf-8')
    .send(buildMultistatus(entries, request, hrefFor));
}

async function proppatch(req: FastifyRequest, reply: FastifyReply, vault: Vault, rel: string) {
  // Tote Properties werden nicht gespeichert → jede Änderung mit 403 beantworten
  await vault.mustStat(rel);
  const body = (await readBody(req)).toString('utf8');
  const names = [...body.matchAll(/<(?:[\w-]+:)?prop>\s*<([\w-]+:)?([\w-]+)/g)].map((m) => m[2]);
  const props = names.map((n) => `<D:${n}/>`).join('');
  const xml =
    `<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>${hrefFor(rel, false)}</D:href>` +
    `<D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 403 Forbidden</D:status></D:propstat></D:response></D:multistatus>`;
  return reply.code(207).type('application/xml; charset=utf-8').send(xml);
}

async function get(req: FastifyRequest, reply: FastifyReply, vault: Vault, rel: string) {
  const entry = await vault.mustStat(rel);
  if (entry.isDir) {
    return reply.code(405).header('Allow', 'OPTIONS, PROPFIND, MKCOL, DELETE, MOVE, COPY').send();
  }
  reply
    .header('ETag', `"${entry.etag}"`)
    .header('Last-Modified', new Date(entry.mtimeMs).toUTCString())
    .header('Content-Type', entry.mime ?? 'application/octet-stream');
  const inm = req.headers['if-none-match'];
  if (inm && inm.split(',').map(stripEtag).includes(entry.etag)) return reply.code(304).send();
  reply.header('Content-Length', String(entry.size));
  if (/^(text\/html|application\/xhtml|image\/svg|application\/xml|text\/xml)/.test(entry.mime ?? '')) {
    reply.header('Content-Disposition', 'attachment');
  }
  if (req.method === 'HEAD') return reply.code(200).send();
  const { stream } = await vault.readStream(rel);
  return reply.code(200).send(stream);
}

async function put(req: FastifyRequest, reply: FastifyReply, vault: Vault, rel: string, max: number) {
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > max) return reply.code(413).send('Datei zu groß');
  const ocMtime = Number(req.headers['x-oc-mtime']);
  const { entry, created } = await vault.write(rel, req.raw, {
    ifMatch: req.headers['if-match'] && req.headers['if-match'] !== '*' ? String(req.headers['if-match']) : undefined,
    ifNoneMatch: req.headers['if-none-match'] === '*',
    mtimeMs: Number.isFinite(ocMtime) && ocMtime > 0 ? ocMtime * 1000 : undefined,
  });
  if (Number.isFinite(ocMtime) && ocMtime > 0) reply.header('X-OC-MTime', 'accepted');
  return reply.code(created ? 201 : 204).header('ETag', `"${entry.etag}"`).send();
}

async function mkcol(req: FastifyRequest, reply: FastifyReply, vault: Vault, rel: string) {
  // Einen evtl. mitgeschickten Body verwerfen statt mit 415 abzulehnen: Obsidian/Remotely Save
  // sendet bei MKCOL einen Body mit (Nextcloud & Co. ignorieren ihn ebenfalls).
  await readBody(req, 64 * 1024);
  await vault.mkdir(rel);
  return reply.code(201).send();
}

async function moveOrCopy(req: FastifyRequest, reply: FastifyReply, vault: Vault, rel: string, baseUrl: string) {
  const dest = req.headers.destination;
  if (!dest) return reply.code(400).send('Destination-Header fehlt');
  let destPath: string;
  try {
    const u = new URL(String(dest), baseUrl);
    destPath = pathFromUrl(u.pathname);
  } catch {
    return reply.code(400).send('Ungültiger Destination-Header');
  }
  if (destPath === rel) return reply.code(403).send('Quelle und Ziel sind identisch');
  const overwrite = String(req.headers.overwrite ?? 'T').toUpperCase() !== 'F';
  const res =
    req.method === 'MOVE'
      ? await vault.move(rel, destPath, { overwrite })
      : await vault.copy(rel, destPath, { overwrite });
  return reply.code(res.created ? 201 : 204).send();
}
