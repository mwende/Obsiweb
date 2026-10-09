import path from 'node:path';
import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().default(3000),
  HOST: z.string().default('127.0.0.1'),
  BASE_URL: z.string().url().default('http://localhost:3000'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET muss mindestens 32 Zeichen lang sein'),
  // mysql://user:pass@host:3306/db  oder  sqlite:./data/dev.sqlite
  DATABASE_URL: z.string(),
  DATA_DIR: z.string().default('./data'),
  MAX_UPLOAD_MB: z.coerce.number().default(100),
  ATTACHMENTS_DIR: z.string().default('attachments'),
  ENTRA_TENANT_ID: z.string().optional(),
  ENTRA_CLIENT_ID: z.string().optional(),
  ENTRA_CLIENT_SECRET: z.string().optional(),
  // Kommagetrennte Liste erlaubter Tenant-IDs (leer = nur ENTRA_TENANT_ID)
  ALLOWED_TENANTS: z.string().optional(),
  // Neue Entra-Nutzer automatisch anlegen (sonst nur Verknüpfung mit bestehendem Konto)
  ENTRA_AUTO_CREATE: z.enum(['true', 'false']).default('false'),
  WEB_DIST: z.string().optional(),
});

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: Record<string, string | undefined> = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Ungültige Konfiguration:\n${msg}`);
  }
  const c = parsed.data;
  const entraEnabled = Boolean(c.ENTRA_TENANT_ID && c.ENTRA_CLIENT_ID && c.ENTRA_CLIENT_SECRET);
  return {
    port: c.PORT,
    host: c.HOST,
    baseUrl: c.BASE_URL.replace(/\/$/, ''),
    sessionSecret: c.SESSION_SECRET,
    databaseUrl: c.DATABASE_URL,
    dataDir: path.resolve(c.DATA_DIR),
    maxUploadBytes: c.MAX_UPLOAD_MB * 1024 * 1024,
    attachmentsDir: c.ATTACHMENTS_DIR.replace(/^\/+|\/+$/g, ''),
    webDist: c.WEB_DIST ? path.resolve(c.WEB_DIST) : undefined,
    entra: entraEnabled
      ? {
          tenantId: c.ENTRA_TENANT_ID!,
          clientId: c.ENTRA_CLIENT_ID!,
          clientSecret: c.ENTRA_CLIENT_SECRET!,
          allowedTenants: (c.ALLOWED_TENANTS ?? c.ENTRA_TENANT_ID!)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          autoCreate: c.ENTRA_AUTO_CREATE === 'true',
        }
      : undefined,
  };
}
