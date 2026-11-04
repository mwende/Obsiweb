import path from 'node:path';
import { VaultError } from './errors.js';

/** Entspricht der Spaltenbreite von files.path */
const MAX_PATH_LENGTH = 1024;

/**
 * Normalisiert einen vault-relativen Pfad ("Ordner/Notiz.md").
 * Leerer String = Vault-Wurzel. Die Unicode-Form wird bewusst NICHT verändert,
 * damit Clients (z.B. macOS mit NFD) exakt den Namen zurückbekommen, den sie hochgeladen haben.
 */
export function normalizeVaultPath(input: string): string {
  if (input.includes('\0') || input.includes('\\')) throw new VaultError('BAD_PATH', `Ungültiger Pfad: ${input}`);
  const parts: string[] = [];
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw new VaultError('BAD_PATH', `Ungültiger Pfad: ${input}`);
    if (Buffer.byteLength(seg) > 255) throw new VaultError('BAD_PATH', 'Dateiname zu lang');
    parts.push(seg);
  }
  const normalized = parts.join('/');
  if (normalized.length > MAX_PATH_LENGTH) throw new VaultError('BAD_PATH', 'Pfad zu lang');
  return normalized;
}

export function toAbsolute(root: string, rel: string): string {
  const abs = path.join(root, ...rel.split('/').filter(Boolean));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new VaultError('BAD_PATH', 'Pfad außerhalb des Vaults');
  return abs;
}

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

export function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf('/') + 1);
}

export function joinVault(...parts: string[]): string {
  return normalizeVaultPath(parts.filter(Boolean).join('/'));
}

/**
 * true für interne Dateien, die in der Web-App nicht erscheinen sollen:
 * Segmente mit "." am Anfang (.obsidian, .trash, …) und Remotely-Save-Metadaten.
 */
export function isHidden(rel: string): boolean {
  return rel.split('/').some((s) => s.startsWith('.') || s.startsWith('_remotely-save-metadata-on-remote'));
}

const TEXT_EXT = new Set(['.md', '.txt', '.markdown', '.canvas']);
export function isIndexableText(rel: string): boolean {
  return TEXT_EXT.has(path.extname(rel).toLowerCase()) && !isHidden(rel);
}

/** true, wenn `child` gleich `ancestor` ist oder darunter liegt */
export function isWithin(child: string, ancestor: string): boolean {
  return ancestor === '' || child === ancestor || child.startsWith(ancestor + '/');
}
