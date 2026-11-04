import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { FILE_CSP } from './security.js';

/**
 * Optionales Logo der Installation. Die Dateien liegen in $DATA_DIR/branding/ (logo-light.* für helle,
 * logo-dark.* für dunkle Hintergründe) und überstehen dadurch jedes Update des Codes.
 */
export const LOGO_VARIANTS = ['light', 'dark'] as const;
export type LogoVariant = (typeof LOGO_VARIANTS)[number];
export const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  svg: 'image/svg+xml',
};

export const isLogoVariant = (v: string): v is LogoVariant => (LOGO_VARIANTS as readonly string[]).includes(v);

/** Erkennt das Format am Inhalt, nicht am Dateinamen */
export function detectImageType(data: Buffer): keyof typeof TYPES | null {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'jpg';
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  const head = data.subarray(0, 1024).toString('utf8').replace(/^﻿/, '').trimStart();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}

export class BrandingStore {
  readonly dir: string;
  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'branding');
  }

  private async find(variant: LogoVariant): Promise<{ file: string; ext: string; mtimeMs: number } | null> {
    for (const ext of Object.keys(TYPES)) {
      const file = path.join(this.dir, `logo-${variant}.${ext}`);
      const st = await fsp.stat(file).catch(() => null);
      if (st?.isFile()) return { file, ext, mtimeMs: st.mtimeMs };
    }
    return null;
  }

  /** Eine fehlende Variante fällt auf die jeweils andere zurück */
  async resolve(variant: LogoVariant) {
    return (await this.find(variant)) ?? (await this.find(variant === 'light' ? 'dark' : 'light'));
  }

  async urls(): Promise<Record<LogoVariant, string | null>> {
    const url = async (v: LogoVariant) => {
      const f = await this.resolve(v);
      return f ? `/branding/logo/${v}?v=${Math.floor(f.mtimeMs)}` : null;
    };
    return { light: await url('light'), dark: await url('dark') };
  }

  async save(variant: LogoVariant, ext: string, data: Buffer): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const target = path.join(this.dir, `logo-${variant}.${ext}`);
    const tmp = `${target}.tmp`;
    await fsp.writeFile(tmp, data);
    await fsp.rename(tmp, target);
    for (const other of Object.keys(TYPES)) {
      if (other !== ext) await fsp.rm(path.join(this.dir, `logo-${variant}.${other}`), { force: true });
    }
  }

  async remove(variant: LogoVariant): Promise<void> {
    for (const ext of Object.keys(TYPES)) {
      await fsp.rm(path.join(this.dir, `logo-${variant}.${ext}`), { force: true });
    }
  }
}

/** Öffentlich: Das Logo erscheint auch auf der Login-Seite */
export async function brandingRoutes(app: FastifyInstance, opts: { branding: BrandingStore }) {
  const { branding } = opts;

  app.get('/branding', async (_req, reply) => {
    reply.header('Cache-Control', 'no-cache');
    return branding.urls();
  });

  app.get('/branding/logo/:variant', async (req, reply) => {
    const { variant } = req.params as { variant: string };
    const logo = isLogoVariant(variant) ? await branding.resolve(variant) : null;
    if (!logo) return reply.code(404).send({ error: 'Kein Logo hinterlegt' });
    return reply
      .header('Content-Type', TYPES[logo.ext])
      .header('Cache-Control', 'public, max-age=3600')
      .header('Content-Security-Policy', FILE_CSP) // SVG kann Skripte enthalten
      .send(fs.createReadStream(logo.file));
  });
}
