import type { Db } from '../db/knex.js';

export interface User {
  id: number;
  email: string;
  displayName: string;
  isAdmin: boolean;
  hasPassword: boolean;
  entraLinked: boolean;
}

export interface UserRow {
  id: number;
  email: string;
  display_name: string;
  password_hash: string | null;
  is_admin: number | boolean;
  entra_oid: string | null;
  tenant_id: string | null;
}

export function toUser(r: UserRow): User {
  return {
    id: r.id,
    email: r.email,
    displayName: r.display_name,
    isAdmin: Boolean(r.is_admin),
    hasPassword: Boolean(r.password_hash),
    entraLinked: Boolean(r.entra_oid),
  };
}

export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export async function findUserByEmail(db: Db, email: string): Promise<UserRow | undefined> {
  return db('users').where({ email: normalizeEmail(email) }).first();
}

export async function findUserById(db: Db, id: number): Promise<UserRow | undefined> {
  return db('users').where({ id }).first();
}

export async function createUser(
  db: Db,
  u: { email: string; displayName: string; passwordHash?: string | null; isAdmin?: boolean; entraOid?: string; tenantId?: string },
): Promise<UserRow> {
  const [id] = await db('users').insert({
    email: normalizeEmail(u.email),
    display_name: u.displayName,
    password_hash: u.passwordHash ?? null,
    is_admin: u.isAdmin ?? false,
    entra_oid: u.entraOid ?? null,
    tenant_id: u.tenantId ?? null,
  });
  return (await findUserById(db, Number(id)))!;
}
