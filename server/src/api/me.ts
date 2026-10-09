import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BasicAuthVerifier } from '../auth/appPasswords.js';
import { createAppPassword, deleteAppPassword, listAppPasswords } from '../auth/appPasswords.js';
import { hashPassword, validateNewPassword, verifyPassword } from '../auth/passwords.js';
import { findUserById } from '../auth/users.js';
import type { Config } from '../config.js';
import type { Db } from '../db/knex.js';

export async function meRoutes(app: FastifyInstance, opts: { db: Db; config: Config; basicAuth: BasicAuthVerifier }) {
  const { db, config, basicAuth } = opts;

  app.get('/api/me', async (req) => ({
    user: req.user,
    csrf: req.csrf,
    davUrl: `${config.baseUrl}/dav/`,
    attachmentsDir: config.attachmentsDir,
  }));

  app.post('/api/me/password', async (req, reply) => {
    const body = z.object({ current: z.string().optional(), next: z.string() }).parse(req.body);
    const u = (await findUserById(db, req.user!.id))!;
    if (u.password_hash && !(await verifyPassword(body.current ?? '', u.password_hash))) {
      return reply.code(400).send({ error: 'Aktuelles Passwort ist falsch' });
    }
    let next: string;
    try {
      next = validateNewPassword(body.next);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    await db('users').where({ id: u.id }).update({ password_hash: await hashPassword(next) });
    return { ok: true };
  });

  app.get('/api/app-passwords', async (req) => ({ items: await listAppPasswords(db, req.user!.id) }));

  app.post('/api/app-passwords', async (req) => {
    const { label } = z.object({ label: z.string().trim().min(1).max(255) }).parse(req.body);
    const { id, token } = await createAppPassword(db, req.user!.id, label);
    return { id, label, token };
  });

  app.delete('/api/app-passwords/:id', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    if (!(await deleteAppPassword(db, req.user!.id, id))) return reply.code(404).send({ error: 'Nicht gefunden' });
    basicAuth.clear();
    return { ok: true };
  });
}
