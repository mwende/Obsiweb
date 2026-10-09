import fsp from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { BasicAuthVerifier } from '../auth/appPasswords.js';
import { hashPassword, validateNewPassword } from '../auth/passwords.js';
import { requireAdmin } from '../auth/plugin.js';
import { createUser, findUserByEmail, findUserById, toUser } from '../auth/users.js';
import type { Db } from '../db/knex.js';
import type { VaultStore } from '../vault/VaultService.js';

const createBody = z.object({
  email: z.string().email(),
  displayName: z.string().trim().min(1),
  password: z.string().optional(),
  isAdmin: z.boolean().default(false),
});
const updateBody = z.object({
  displayName: z.string().trim().min(1).optional(),
  password: z.string().optional(),
  isAdmin: z.boolean().optional(),
});

export async function adminRoutes(app: FastifyInstance, opts: { db: Db; store: VaultStore; basicAuth: BasicAuthVerifier }) {
  const { db, store, basicAuth } = opts;
  app.addHook('preHandler', requireAdmin);

  app.get('/api/admin/users', async () => {
    const rows = await db('users').orderBy('email');
    return { users: rows.map(toUser) };
  });

  app.post('/api/admin/users', async (req, reply) => {
    const body = createBody.parse(req.body);
    if (await findUserByEmail(db, body.email)) return reply.code(409).send({ error: 'E-Mail ist bereits vergeben' });
    let passwordHash: string | null = null;
    if (body.password) {
      try {
        passwordHash = await hashPassword(validateNewPassword(body.password));
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
    const u = await createUser(db, { email: body.email, displayName: body.displayName, passwordHash, isAdmin: body.isAdmin });
    await store.forUser(u.id).ensureRoot();
    return { user: toUser(u) };
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const body = updateBody.parse(req.body);
    if (!(await findUserById(db, id))) return reply.code(404).send({ error: 'Nicht gefunden' });
    if (id === req.user!.id && body.isAdmin === false) return reply.code(400).send({ error: 'Eigene Admin-Rechte können nicht entzogen werden' });
    const patch: Record<string, unknown> = {};
    if (body.displayName) patch.display_name = body.displayName;
    if (body.isAdmin !== undefined) patch.is_admin = body.isAdmin;
    if (body.password) {
      try {
        patch.password_hash = await hashPassword(validateNewPassword(body.password));
      } catch (e) {
        return reply.code(400).send({ error: (e as Error).message });
      }
    }
    if (Object.keys(patch).length) await db('users').where({ id }).update(patch);
    return { user: toUser((await findUserById(db, id))!) };
  });

  app.delete('/api/admin/users/:id', async (req, reply) => {
    const { id } = z.object({ id: z.coerce.number() }).parse(req.params);
    const { deleteVault } = z.object({ deleteVault: z.enum(['true', 'false']).default('false') }).parse(req.query);
    if (id === req.user!.id) return reply.code(400).send({ error: 'Das eigene Konto kann nicht gelöscht werden' });
    const n = await db('users').where({ id }).delete();
    if (!n) return reply.code(404).send({ error: 'Nicht gefunden' });
    basicAuth.clear();
    if (deleteVault === 'true') await fsp.rm(store.forUser(id).root, { recursive: true, force: true });
    return { ok: true };
  });

  app.post('/api/admin/reindex', async () => {
    const users: Array<{ id: number }> = await db('users').select('id');
    const result: Record<number, { updated: number; removed: number }> = {};
    for (const u of users) result[u.id] = await store.forUser(u.id).reconcile();
    return { result };
  });
}
