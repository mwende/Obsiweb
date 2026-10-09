import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyServerOptions } from 'fastify';
import { ZodError } from 'zod';
import { adminRoutes } from './api/admin.js';
import { fileRoutes } from './api/files.js';
import { meRoutes } from './api/me.js';
import { BasicAuthVerifier } from './auth/appPasswords.js';
import { localAuthRoutes } from './auth/local.js';
import { entraRoutes } from './auth/oidc.js';
import { sessionHook } from './auth/plugin.js';
import type { Config } from './config.js';
import { davPlugin, DAV_PREFIX } from './dav/server.js';
import type { Db } from './db/knex.js';
import { httpStatusFor, VaultError } from './vault/errors.js';
import { securityHeaders } from './security.js';
import { VaultStore } from './vault/VaultService.js';

export async function buildApp(config: Config, db: Db, fastifyOpts: FastifyServerOptions = {}) {
  // Nur dem lokalen Reverse-Proxy (Nginx) vertrauen: request.ip ist dann der von Nginx angehängte,
  // rechte X-Forwarded-For-Eintrag. Mit `true` könnte ein Client seine IP fälschen (Rate-Limit-Umgehung).
  const app = Fastify({ trustProxy: ['127.0.0.1', '::1'], bodyLimit: 10 * 1024 * 1024, ...fastifyOpts });
  for (const m of ['PROPFIND', 'PROPPATCH', 'MKCOL']) app.addHttpMethod(m, { hasBody: true });
  for (const m of ['MOVE', 'COPY']) app.addHttpMethod(m);

  const store = new VaultStore(db, config.dataDir, config.maxUploadBytes);
  await store.init();
  const basicAuth = new BasicAuthVerifier(db);

  app.addHook('onRequest', securityHeaders(config.baseUrl));
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { global: false });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof VaultError) {
      return reply.code(httpStatusFor(err.code)).send({ error: err.message, code: err.code, currentEtag: err.currentEtag });
    }
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'Ungültige Anfrage', details: err.issues });
    }
    const status = (err as any).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'Interner Fehler' : (err as Error).message });
  });

  // ---- WebDAV (eigener Kontext: eigene Body-Verarbeitung, Basic-Auth)
  await app.register(davPlugin, { store, basicAuth, baseUrl: config.baseUrl, maxUploadBytes: config.maxUploadBytes });

  // ---- Öffentliche Auth-Routen
  await app.register(localAuthRoutes, { db, config });
  if (config.entra) await app.register(entraRoutes, { db, config });
  app.get('/auth/providers', async () => ({ local: true, entra: Boolean(config.entra) }));

  // ---- Geschützte REST-API
  await app.register(async (api) => {
    await api.register(multipart);
    api.addHook('preHandler', sessionHook(db));
    await api.register(fileRoutes, { db, store, config });
    await api.register(meRoutes, { db, config, basicAuth });
    await api.register(adminRoutes, { db, store, basicAuth });
  });

  // ---- SPA
  const webDist = config.webDist ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false, index: false });
    app.setNotFoundHandler((req, reply) => {
      const url = req.url.split('?')[0];
      if (req.method !== 'GET' || url.startsWith('/api/') || url.startsWith('/auth/') || url.startsWith(DAV_PREFIX)) {
        return reply.code(404).send({ error: 'Nicht gefunden' });
      }
      const file = path.join(webDist, url);
      if (url !== '/' && file.startsWith(webDist + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return reply.sendFile(url.slice(1));
      }
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    });
  }

  return { app, store };
}
