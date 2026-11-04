import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/knex.js';
import { getSession, SESSION_COOKIE } from './sessions.js';
import type { User } from './users.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: User;
    csrf?: string;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Lädt die Session aus dem Cookie und prüft CSRF bei schreibenden Requests. */
export function sessionHook(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store');
    const s = await getSession(db, req.cookies[SESSION_COOKIE]);
    if (!s) return reply.code(401).send({ error: 'Nicht angemeldet' });
    if (!SAFE_METHODS.has(req.method) && req.headers['x-csrf-token'] !== s.csrf) {
      return reply.code(403).send({ error: 'CSRF-Token ungültig' });
    }
    req.user = s.user;
    req.csrf = s.csrf;
  };
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (!req.user?.isAdmin) return reply.code(403).send({ error: 'Nur für Administratoren' });
}

export function cookieOptions(baseUrl: string, maxAgeSec: number) {
  return {
    path: '/',
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: baseUrl.startsWith('https://'),
    maxAge: maxAgeSec,
  };
}

export type AppInstance = FastifyInstance;
