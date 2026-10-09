import type { FastifyReply, FastifyRequest } from 'fastify';

/** CSP für die Web-App. Styles inline nötig (CodeMirror erzeugt <style>, React style-Attribute). */
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:", // externe Bilder in Notizen erlauben
  "connect-src 'self'",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://login.microsoftonline.com",
  "frame-ancestors 'none'",
].join('; ');

/** Vault-Dateien (WebDAV) nie als aktive Inhalte im Kontext der App ausführen lassen */
export const FILE_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; sandbox";

export function securityHeaders(baseUrl: string) {
  const https = baseUrl.startsWith('https://');
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    if (https) reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    reply.header('Content-Security-Policy', req.url.startsWith('/dav') ? FILE_CSP : APP_CSP);
  };
}

/**
 * Zählt fehlgeschlagene Anmeldungen pro Schlüssel (z.B. IP) in einem Zeitfenster.
 * Nach `max` Fehlschlägen wird bis zum Ende des Fensters blockiert.
 */
export class FailureLimiter {
  private hits = new Map<string, { count: number; reset: number }>();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Restzeit in Sekunden, falls gesperrt, sonst 0 */
  blockedFor(key: string): number {
    const h = this.hits.get(key);
    if (!h) return 0;
    if (h.reset <= Date.now()) {
      this.hits.delete(key);
      return 0;
    }
    return h.count >= this.max ? Math.ceil((h.reset - Date.now()) / 1000) : 0;
  }

  fail(key: string): void {
    const now = Date.now();
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.reset <= now) this.hits.delete(k);
    }
    const h = this.hits.get(key);
    if (!h || h.reset <= now) this.hits.set(key, { count: 1, reset: now + this.windowMs });
    else h.count++;
  }

  succeed(key: string): void {
    this.hits.delete(key);
  }
}
