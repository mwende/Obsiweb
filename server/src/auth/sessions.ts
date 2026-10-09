import type { Db } from '../db/knex.js';
import { randomToken, sha256 } from './passwords.js';
import { findUserById, toUser, type User } from './users.js';

export const SESSION_COOKIE = 'ow_sid';
export const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export async function createSession(db: Db, userId: number): Promise<{ token: string; csrf: string }> {
  const token = randomToken();
  const csrf = randomToken(24);
  await db('sessions').insert({ id: sha256(token), user_id: userId, csrf, expires_at: Date.now() + SESSION_TTL_MS });
  // Gelegentlich abgelaufene Sessions aufräumen
  if (Math.random() < 0.05) await db('sessions').where('expires_at', '<', Date.now()).delete();
  return { token, csrf };
}

export async function getSession(db: Db, token: string | undefined): Promise<{ user: User; csrf: string } | null> {
  if (!token) return null;
  const row = await db('sessions').where({ id: sha256(token) }).first();
  if (!row || Number(row.expires_at) < Date.now()) return null;
  const u = await findUserById(db, row.user_id);
  return u ? { user: toUser(u), csrf: row.csrf } : null;
}

export async function deleteSession(db: Db, token: string | undefined): Promise<void> {
  if (token) await db('sessions').where({ id: sha256(token) }).delete();
}

/** Beendet alle Sitzungen eines Nutzers, optional außer der aktuellen (z.B. nach Passwortwechsel). */
export async function revokeSessions(db: Db, userId: number, keepToken?: string): Promise<void> {
  const q = db('sessions').where({ user_id: userId });
  if (keepToken) q.whereNot({ id: sha256(keepToken) });
  await q.delete();
}
