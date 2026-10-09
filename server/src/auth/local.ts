import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/knex.js';
import { verifyPassword } from './passwords.js';
import { cookieOptions } from './plugin.js';
import { createSession, deleteSession, SESSION_COOKIE, SESSION_TTL_MS } from './sessions.js';
import { findUserByEmail, toUser } from './users.js';

const loginSchema = z.object({ email: z.string().min(1), password: z.string().min(1) });

// Dummy-Hash, damit unbekannte E-Mails gleich lange brauchen wie falsche Passwörter
const DUMMY_HASH = 'scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function localAuthRoutes(app: FastifyInstance, opts: { db: Db; config: Config }) {
  const { db, config } = opts;

  app.post(
    '/auth/login',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
        return reply.code(415).send({ error: 'JSON erwartet' });
      }
      const body = loginSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: 'E-Mail und Passwort erforderlich' });
      const u = await findUserByEmail(db, body.data.email);
      const ok = await verifyPassword(body.data.password, u?.password_hash ?? DUMMY_HASH);
      if (!u || !u.password_hash || !ok) return reply.code(401).send({ error: 'E-Mail oder Passwort falsch' });
      const { token, csrf } = await createSession(db, u.id);
      reply.setCookie(SESSION_COOKIE, token, cookieOptions(config.baseUrl, SESSION_TTL_MS / 1000));
      return { user: toUser(u), csrf };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    await deleteSession(db, req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
