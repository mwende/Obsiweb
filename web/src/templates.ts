/**
 * Vorlagen kompatibel zum Obsidian-Core-Plugin „Vorlagen“:
 * Ordner aus `<vault>/.obsidian/templates.json` (falls mitsynchronisiert), sonst ein Ordner
 * namens „Templates“/„Vorlagen“; Platzhalter {{title}}, {{date}}, {{time}}, {{date:FORMAT}}.
 */
import { api, ApiError, type TreeEntry } from './api';
import { baseOf, isNote, joinPath, stripMd } from './links';

export interface TemplateConfig {
  folder: string | null; // vault-relativer Pfad des Vorlagenordners
  dateFormat: string;
  timeFormat: string;
  source: 'manual' | 'obsidian' | 'auto' | 'none';
}

const FALLBACK_NAMES = ['templates', 'vorlagen', '_templates', 'z_templates'];
export const TEMPLATE_FOLDER_KEY = 'ow.templatesFolder';

export function getManualFolder(): string {
  try {
    return localStorage.getItem(TEMPLATE_FOLDER_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setManualFolder(folder: string) {
  try {
    if (folder.trim()) localStorage.setItem(TEMPLATE_FOLDER_KEY, joinPath(folder.trim()));
    else localStorage.removeItem(TEMPLATE_FOLDER_KEY);
  } catch {
    /* privates Fenster */
  }
}

/** Remotely Save legt jeden Vault in einem eigenen obersten Ordner ab → erster Pfadteil */
export function vaultRootOf(notePath: string | null): string {
  return notePath && notePath.includes('/') ? notePath.split('/')[0] : '';
}

export async function resolveTemplateConfig(entries: TreeEntry[], notePath: string | null): Promise<TemplateConfig> {
  const dirs = new Set(entries.filter((e) => e.isDir).map((e) => e.path));
  const base = { dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' };

  const manual = getManualFolder();
  if (manual) return { ...base, folder: dirs.has(manual) ? manual : null, source: 'manual' };

  const root = vaultRootOf(notePath);
  for (const r of new Set([root, ''])) {
    try {
      const f = await api.read(joinPath(r, '.obsidian/templates.json'));
      const cfg = JSON.parse(f.content) as { folder?: string; dateFormat?: string; timeFormat?: string };
      const folder = cfg.folder ? joinPath(r, cfg.folder) : null;
      if (folder && dirs.has(folder)) {
        return {
          folder,
          dateFormat: cfg.dateFormat || base.dateFormat,
          timeFormat: cfg.timeFormat || base.timeFormat,
          source: 'obsidian',
        };
      }
    } catch (e) {
      if (!(e instanceof ApiError) && !(e instanceof SyntaxError)) throw e;
    }
  }

  const candidates = [...dirs].filter((d) => FALLBACK_NAMES.includes(baseOf(d).toLowerCase()));
  candidates.sort((a, b) => {
    const inRoot = (p: string) => (root && (p === root || p.startsWith(`${root}/`)) ? 0 : 1);
    return inRoot(a) - inRoot(b) || a.split('/').length - b.split('/').length;
  });
  return { ...base, folder: candidates[0] ?? null, source: candidates[0] ? 'auto' : 'none' };
}

export function listTemplates(entries: TreeEntry[], folder: string): Array<{ path: string; name: string }> {
  return entries
    .filter((e) => !e.isDir && isNote(e.path) && e.path.startsWith(`${folder}/`))
    .map((e) => ({ path: e.path, name: stripMd(e.path.slice(folder.length + 1)) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'de', { numeric: true }));
}

const DAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/** Teilmenge der moment.js-Formatierung, die Obsidian verwendet. Text in [eckigen Klammern] bleibt wörtlich. */
export function formatDate(d: Date, fmt: string): string {
  const pad = (n: number, l = 2) => String(n).padStart(l, '0');
  const tokens: Record<string, () => string> = {
    YYYY: () => String(d.getFullYear()),
    YY: () => String(d.getFullYear()).slice(-2),
    MMMM: () => MONTHS[d.getMonth()],
    MMM: () => MONTHS[d.getMonth()].slice(0, 3),
    MM: () => pad(d.getMonth() + 1),
    M: () => String(d.getMonth() + 1),
    DD: () => pad(d.getDate()),
    D: () => String(d.getDate()),
    dddd: () => DAYS[d.getDay()],
    ddd: () => DAYS[d.getDay()].slice(0, 2),
    HH: () => pad(d.getHours()),
    H: () => String(d.getHours()),
    mm: () => pad(d.getMinutes()),
    ss: () => pad(d.getSeconds()),
    ww: () => pad(isoWeek(d)),
    w: () => String(isoWeek(d)),
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|mm|ss|ww|w/g, (m, lit) =>
    lit !== undefined ? lit : tokens[m](),
  );
}

function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function applyTemplate(
  content: string,
  ctx: { title: string; now?: Date; dateFormat: string; timeFormat: string },
): string {
  const now = ctx.now ?? new Date();
  return content.replace(/\{\{\s*(title|date|time)(?::([^}]*))?\s*\}\}/gi, (_m, name: string, fmt?: string) => {
    switch (name.toLowerCase()) {
      case 'title':
        return ctx.title;
      case 'date':
        return formatDate(now, fmt?.trim() || ctx.dateFormat);
      default:
        return formatDate(now, fmt?.trim() || ctx.timeFormat);
    }
  });
}

export const titleOf = (notePath: string) => stripMd(baseOf(notePath));
