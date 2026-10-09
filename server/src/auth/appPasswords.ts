import type { Db } from '../db/knex.js';
import { randomToken, sha256 } from './passwords.js';
import { findUserByEmail, toUser, type User } from './users.js';

export async function createAppPassword(db: Db, userId: number, label: string): Promise<{ id: number; token: string }> {
  const token = `ow_${randomToken(24)}`;
  const [id] = await db('app_passwords').insert({ user_id: userId, label, hash: sha256(token) });
  return { id: Number(id), token };
}

export async function listAppPasswords(db: Db, userId: number) {
  const rows = await db('app_passwords').where({ user_id: userId }).select('id', 'label', 'last_used_at', 'created_at').orderBy('id');
  return rows.map((r: any) => ({
    id: r.id,
    label: r.label,
    lastUsedAt: r.last_used_at ? Number(r.last_used_at) : null,
    createdAt: r.created_at,
  }));
}

export async function deleteAppPassword(db: Db, userId: number, id: number): Promise<boolean> {
  return (await db('app_passwords').where({ user_id: userId, id }).delete()) > 0;
}

interface CacheEntry {
  user: User;
  expires: number;
}

/** Prüft HTTP-Basic-Zugangsdaten (E-Mail + App-Passwort) mit kurzem In-Memory-Cache. */
export class BasicAuthVerifier {
  private cache = new Map<string, CacheEntry>();
  constructor(
    private readonly db: Db,
    private readonly ttlMs = 60_000,
  ) {}

  async verify(authorization: string | undefined): Promise<User | null> {
    if (!authorization?.startsWith('Basic ')) return null;
    const key = sha256(authorization);
    const hit = this.cache.get(key);
    if (hit && hit.expires > Date.now()) return hit.user;

    const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i === -1) return null;
    const email = decoded.slice(0, i);
    const token = decoded.slice(i + 1);
    const u = await findUserByEmail(this.db, email);
    if (!u) return null;
    const row = await this.db('app_passwords').where({ user_id: u.id, hash: sha256(token) }).first('id');
    if (!row) return null;
    await this.db('app_passwords').where({ id: row.id }).update({ last_used_at: Date.now() });
    const user = toUser(u);
    if (this.cache.size > 1000) this.cache.clear();
    this.cache.set(key, { user, expires: Date.now() + this.ttlMs });
    return user;
  }

  /** Nach Widerruf eines App-Passworts sofort wirksam machen */
  clear(): void {
    this.cache.clear();
  }
}
